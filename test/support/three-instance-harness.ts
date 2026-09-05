import { createServer } from 'node:net';

import type { EnvironmentSource } from '../../src/bootstrap/configuration/environment.schema.js';

const CHILD_CONFIGURATION_VARIABLE = 'THREE_INSTANCE_HARNESS_CHILD_CONFIGURATION';
const INSTANCE_ID_VARIABLE = 'THREE_INSTANCE_ID';
const INSTANCE_COUNT = 3;
const MINIMUM_DERIVED_PORT = 20_000;
const MAXIMUM_DERIVED_BASE_PORT = 64_000;
const PORT_GROUP_ATTEMPTS = 128;
const READINESS_RETRY_INTERVAL_MS = 50;
const MAXIMUM_MARKER_LINE_CHARACTERS = 4_096;

type ServiceProcess = ReturnType<typeof Bun.spawn>;
type InstanceState = 'failed' | 'ready' | 'starting' | 'stopped' | 'stopping';

export interface ThreeInstanceHarnessOptions {
  readonly environment: EnvironmentSource;
  readonly runId: string;
  readonly basePort?: number;
  readonly host?: string;
  readonly readinessPath?: string;
  readonly serviceCommand?: readonly string[];
  readonly shutdownTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

interface RunningServiceInstance {
  readonly baseUrl: string;
  readonly instanceId: string;
  readonly port: number;
  readonly processId: number;
}

interface ServiceInstanceDiagnostic extends RunningServiceInstance {
  readonly events: readonly string[];
  readonly exitCode: number | null;
  readonly state: InstanceState;
  readonly standardErrorBytes: number;
  readonly standardOutputBytes: number;
}

export interface ThreeInstanceHarness {
  readonly instances: readonly RunningServiceInstance[];
  diagnostics(): readonly ServiceInstanceDiagnostic[];
  stop(): Promise<void>;
}

interface MutableInstanceDiagnostic {
  events: string[];
  exitCode: number | null;
  standardErrorBytes: number;
  standardOutputBytes: number;
  state: InstanceState;
}

interface InternalServiceInstance extends RunningServiceInstance {
  readonly diagnostic: MutableInstanceDiagnostic;
  readonly process: ServiceProcess;
}

interface PortReservation {
  readonly port: number;
  release(): Promise<void>;
}

interface ChildConfiguration {
  readonly environment: EnvironmentSource;
  readonly instanceId: string;
}

const SAFE_CHILD_EVENTS = new Set(['FATAL', 'READY', 'STOPPED', 'STOPPING']);

function assertBoundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function deriveThreeInstancePorts(runId: string): readonly [number, number, number] {
  if (runId.trim().length === 0) {
    throw new TypeError('runId must not be empty');
  }
  const availableBasePorts = MAXIMUM_DERIVED_BASE_PORT - MINIMUM_DERIVED_PORT + 1;
  const basePort = MINIMUM_DERIVED_PORT + (stableHash(runId) % availableBasePorts);
  return Object.freeze([basePort, basePort + 1, basePort + 2]);
}

function portsFromBase(basePort: number): readonly [number, number, number] {
  assertBoundedInteger(basePort, 'basePort', 1, 65_533);
  return Object.freeze([basePort, basePort + 1, basePort + 2]);
}

function isAddressUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EADDRINUSE' || error.code === 'EACCES')
  );
}

async function reservePort(host: string, port: number): Promise<PortReservation> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  server.unref();
  let released = false;
  return {
    port,
    release: () =>
      new Promise<void>((resolve, reject) => {
        if (released) {
          resolve();
          return;
        }
        released = true;
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}

async function releaseReservations(reservations: readonly PortReservation[]): Promise<void> {
  await Promise.all(reservations.map((reservation) => reservation.release()));
}

async function tryReservePortGroup(
  host: string,
  ports: readonly [number, number, number],
): Promise<readonly PortReservation[] | null> {
  const reservations: PortReservation[] = [];
  try {
    for (const port of ports) {
      reservations.push(await reservePort(host, port));
    }
    return Object.freeze(reservations);
  } catch (error) {
    await releaseReservations(reservations);
    if (isAddressUnavailable(error)) {
      return null;
    }
    throw error;
  }
}

async function reservePortGroup(
  host: string,
  runId: string,
  requestedBasePort: number | undefined,
): Promise<readonly PortReservation[]> {
  if (requestedBasePort !== undefined) {
    const reservations = await tryReservePortGroup(host, portsFromBase(requestedBasePort));
    if (reservations === null) {
      throw new Error('The requested three-instance port group is unavailable');
    }
    return reservations;
  }

  const [derivedBasePort] = deriveThreeInstancePorts(runId);
  const portRange = MAXIMUM_DERIVED_BASE_PORT - MINIMUM_DERIVED_PORT + 1;
  for (let attempt = 0; attempt < PORT_GROUP_ATTEMPTS; attempt += 1) {
    const candidateBasePort =
      MINIMUM_DERIVED_PORT +
      ((derivedBasePort - MINIMUM_DERIVED_PORT + attempt * INSTANCE_COUNT) % portRange);
    const reservations = await tryReservePortGroup(host, portsFromBase(candidateBasePort));
    if (reservations !== null) {
      return reservations;
    }
  }
  throw new Error('No isolated three-instance port group is available');
}

function parseSafeEvent(line: string, expectedInstanceId: string): string | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.event !== 'string' ||
      !SAFE_CHILD_EVENTS.has(record.event) ||
      record.instanceId !== expectedInstanceId
    ) {
      return null;
    }
    return record.event;
  } catch {
    return null;
  }
}

async function consumeStandardOutput(
  stream: ReadableStream<Uint8Array>,
  instanceId: string,
  diagnostic: MutableInstanceDiagnostic,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    diagnostic.standardOutputBytes += value.byteLength;
    pending += decoder.decode(value, { stream: true });
    if (pending.length > MAXIMUM_MARKER_LINE_CHARACTERS) {
      pending = pending.slice(-MAXIMUM_MARKER_LINE_CHARACTERS);
    }
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const event = parseSafeEvent(line, instanceId);
      if (event !== null) {
        diagnostic.events.push(event);
      }
    }
  }
}

async function countBytes(
  stream: ReadableStream<Uint8Array>,
  diagnostic: MutableInstanceDiagnostic,
): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    diagnostic.standardErrorBytes += value.byteLength;
  }
}

function diagnosticSummary(instance: InternalServiceInstance): string {
  return [
    `instance=${instance.instanceId}`,
    `port=${String(instance.port)}`,
    `state=${instance.diagnostic.state}`,
    `exitCode=${String(instance.diagnostic.exitCode)}`,
    `events=${instance.diagnostic.events.join(',') || 'none'}`,
    `stdoutBytes=${String(instance.diagnostic.standardOutputBytes)}`,
    `stderrBytes=${String(instance.diagnostic.standardErrorBytes)}`,
  ].join(' ');
}

async function waitForReadiness(
  instance: InternalServiceInstance,
  readinessPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (instance.diagnostic.exitCode !== null) {
      throw new Error(`Service exited before readiness: ${diagnosticSummary(instance)}`);
    }
    const remainingMs = deadline - Date.now();
    try {
      const response = await fetch(`${instance.baseUrl}${readinessPath}`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, remainingMs))),
      });
      if (response.ok) {
        instance.diagnostic.state = 'ready';
        return;
      }
    } catch {
      // The service can refuse connections while Nest and its dependencies initialize.
    }
    await Bun.sleep(Math.min(READINESS_RETRY_INTERVAL_MS, Math.max(1, remainingMs)));
  }
  throw new Error(`Timed out waiting for service readiness: ${diagnosticSummary(instance)}`);
}

async function waitForExit(process: ServiceProcess, timeoutMs: number): Promise<number | null> {
  const result = await Promise.race([
    process.exited.then((exitCode) => ({ exitCode })),
    Bun.sleep(timeoutMs).then(() => null),
  ]);
  return result?.exitCode ?? null;
}

async function stopInstance(
  instance: InternalServiceInstance,
  shutdownTimeoutMs: number,
): Promise<void> {
  if (instance.diagnostic.exitCode !== null) {
    instance.diagnostic.state = 'stopped';
    return;
  }
  instance.diagnostic.state = 'stopping';
  instance.process.kill('SIGTERM');
  let exitCode = await waitForExit(instance.process, shutdownTimeoutMs);
  if (exitCode === null) {
    instance.process.kill('SIGKILL');
    exitCode = await waitForExit(instance.process, Math.min(shutdownTimeoutMs, 2_000));
  }
  if (exitCode === null) {
    instance.diagnostic.state = 'failed';
    throw new Error(
      `Service did not stop within the bounded timeout: ${diagnosticSummary(instance)}`,
    );
  }
  instance.diagnostic.exitCode = exitCode;
  instance.diagnostic.state = 'stopped';
}

function snapshotDiagnostic(instance: InternalServiceInstance): ServiceInstanceDiagnostic {
  return Object.freeze({
    baseUrl: instance.baseUrl,
    events: Object.freeze([...instance.diagnostic.events]),
    exitCode: instance.diagnostic.exitCode,
    instanceId: instance.instanceId,
    port: instance.port,
    processId: instance.processId,
    standardErrorBytes: instance.diagnostic.standardErrorBytes,
    standardOutputBytes: instance.diagnostic.standardOutputBytes,
    state: instance.diagnostic.state,
  });
}

export async function startThreeInstanceHarness(
  options: ThreeInstanceHarnessOptions,
): Promise<ThreeInstanceHarness> {
  if (options.runId.trim().length === 0) {
    throw new TypeError('runId must not be empty');
  }
  const host = options.host ?? '127.0.0.1';
  const readinessPath = options.readinessPath ?? '/health/ready';
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  assertBoundedInteger(startupTimeoutMs, 'startupTimeoutMs', 1, 300_000);
  assertBoundedInteger(shutdownTimeoutMs, 'shutdownTimeoutMs', 1, 300_000);
  if (!readinessPath.startsWith('/')) {
    throw new TypeError('readinessPath must start with /');
  }

  const reservations = await reservePortGroup(host, options.runId, options.basePort);
  const instances: InternalServiceInstance[] = [];
  const command = options.serviceCommand ?? [process.execPath, import.meta.path];
  if (command.length === 0) {
    await releaseReservations(reservations);
    throw new TypeError('serviceCommand must not be empty');
  }

  try {
    for (let index = 0; index < INSTANCE_COUNT; index += 1) {
      const reservation = reservations[index];
      if (reservation === undefined) {
        throw new Error('Reserved service port is unavailable');
      }
      await reservation.release();
      const instanceId = `${options.runId}-service-${String(index + 1)}`;
      const port = reservation.port;
      const environment = Object.freeze({
        ...options.environment,
        APP_HOST: host,
        APP_PORT: String(port),
        [INSTANCE_ID_VARIABLE]: instanceId,
      });
      const childConfiguration: ChildConfiguration = {
        environment,
        instanceId,
      };
      const diagnostic: MutableInstanceDiagnostic = {
        events: [],
        exitCode: null,
        standardErrorBytes: 0,
        standardOutputBytes: 0,
        state: 'starting',
      };
      const processHandle = Bun.spawn({
        cmd: [...command],
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...environment,
          [CHILD_CONFIGURATION_VARIABLE]: JSON.stringify(childConfiguration),
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const instance: InternalServiceInstance = {
        baseUrl: `http://${host}:${String(port)}`,
        diagnostic,
        instanceId,
        port,
        process: processHandle,
        processId: processHandle.pid,
      };
      instances.push(instance);
      void consumeStandardOutput(processHandle.stdout, instanceId, diagnostic);
      void countBytes(processHandle.stderr, diagnostic);
      void processHandle.exited.then((exitCode) => {
        diagnostic.exitCode = exitCode;
        if (diagnostic.state === 'ready' || diagnostic.state === 'starting') {
          diagnostic.state = 'failed';
        }
      });
      await waitForReadiness(instance, readinessPath, startupTimeoutMs);
    }
  } catch (error) {
    await releaseReservations(reservations);
    await Promise.allSettled(
      instances.map((instance) => stopInstance(instance, shutdownTimeoutMs)),
    );
    throw error;
  }
  await releaseReservations(reservations);

  let stopPromise: Promise<void> | undefined;
  const publicInstances = Object.freeze(
    instances.map((instance) =>
      Object.freeze({
        baseUrl: instance.baseUrl,
        instanceId: instance.instanceId,
        port: instance.port,
        processId: instance.processId,
      }),
    ),
  );
  return Object.freeze({
    instances: publicInstances,
    diagnostics: () => Object.freeze(instances.map(snapshotDiagnostic)),
    stop: () => {
      stopPromise ??= Promise.all(
        instances.map((instance) => stopInstance(instance, shutdownTimeoutMs)),
      ).then(() => undefined);
      return stopPromise;
    },
  });
}

function parseChildConfiguration(): ChildConfiguration {
  const raw = process.env[CHILD_CONFIGURATION_VARIABLE];
  if (raw === undefined) {
    throw new Error('Three-instance child configuration is required');
  }
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid three-instance child configuration');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.instanceId !== 'string' ||
    typeof record.environment !== 'object' ||
    record.environment === null ||
    Array.isArray(record.environment)
  ) {
    throw new TypeError('Invalid three-instance child configuration');
  }
  return Object.freeze({
    environment: Object.freeze(record.environment as EnvironmentSource),
    instanceId: record.instanceId,
  });
}

function writeChildEvent(event: string, instanceId: string): void {
  process.stdout.write(`${JSON.stringify({ event, instanceId })}\n`);
}

async function runServiceChild(): Promise<void> {
  const configuration = parseChildConfiguration();
  for (const [key, value] of Object.entries(configuration.environment)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
  const [{ NestFactory }, { AppModule }, { parseEnvironment }] = await Promise.all([
    import('@nestjs/core'),
    import('../../src/app.module.js'),
    import('../../src/bootstrap/configuration/environment.schema.js'),
  ]);
  const environment = parseEnvironment(configuration.environment);
  const application = await NestFactory.create(AppModule, { logger: false });
  await application.listen(environment.APP_PORT, environment.APP_HOST);
  writeChildEvent('READY', configuration.instanceId);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    writeChildEvent('STOPPING', configuration.instanceId);
    await application.close();
    writeChildEvent('STOPPED', configuration.instanceId);
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  await new Promise<void>(() => undefined);
}

if (import.meta.main && process.env[CHILD_CONFIGURATION_VARIABLE] !== undefined) {
  runServiceChild().catch(() => {
    const instanceId = process.env[INSTANCE_ID_VARIABLE] ?? 'unknown-service';
    writeChildEvent('FATAL', instanceId);
    process.exit(1);
  });
}
