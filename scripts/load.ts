import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export type LoadTransport = 'http' | 'sqs';
export type LoadScenario =
  'hot_wallet' | 'exact_duplicate' | 'independent_wallet' | 'out_of_order_reference';
export type LoadOutcome =
  | 'processed'
  | 'rejected'
  | 'pending_reference'
  | 'idempotent_replay'
  | 'conflict'
  | 'failed'
  | 'transient_error'
  | 'unexpected_error'
  | 'sqs_accepted';
export type LoadWagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export interface LoadWalletTarget {
  readonly walletId: string;
  readonly playerId: string;
}

export interface LoadBusinessCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: LoadWagerKind;
  readonly money: Readonly<{ amount: string; currency: string }>;
  readonly referenceExternalTransactionId?: string;
}

export interface LoadCommandEnvelope {
  readonly messageId: string;
  readonly type: 'WagerTransactionRequested';
  readonly occurredAt: string;
  readonly data: LoadBusinessCommand;
}

export interface LoadOperation {
  readonly operationId: string;
  readonly scenario: LoadScenario;
  readonly transport: LoadTransport;
  readonly command: LoadBusinessCommand;
  readonly envelope: LoadCommandEnvelope;
  readonly afterOperationId?: string;
}

export interface LoadPlanConfiguration {
  readonly seed: string;
  readonly runId: string;
  readonly operationCount?: number;
  readonly occurredAt?: string;
  readonly providerId?: string;
  readonly hotWallet: LoadWalletTarget;
  readonly independentWallets: readonly LoadWalletTarget[];
}

export interface LoadPlan {
  readonly schemaVersion: 1;
  readonly seed: string;
  readonly runId: string;
  readonly profile: Readonly<{
    hotWallet: number;
    exactDuplicate: number;
    independentWallet: number;
    outOfOrderReference: number;
  }>;
  readonly operations: readonly LoadOperation[];
}

export interface LoadDispatchResult {
  readonly outcome: LoadOutcome;
  readonly statusCode?: number;
  readonly idempotentReplay?: boolean;
}

export type LoadDispatcher = (
  operation: LoadOperation,
  signal: AbortSignal,
) => Promise<LoadDispatchResult>;

export interface LoadDispatchers {
  readonly http: LoadDispatcher;
  readonly sqs: LoadDispatcher;
}

export interface LoadExecutionConfiguration {
  readonly concurrency?: number;
  readonly operationTimeoutMs?: number;
  readonly runTimeoutMs?: number;
  readonly warmupDurationMs?: number;
  readonly processCount?: number;
  readonly dockerMode?: 'direct' | 'wsl' | 'unknown';
}

export interface LoadSample {
  readonly operationId: string;
  readonly scenario: LoadScenario;
  readonly transport: LoadTransport;
  readonly kind: LoadWagerKind;
  readonly outcome: LoadOutcome;
  readonly statusCode?: number;
  readonly latencyMs: number;
}

export interface LoadExecutionResult {
  readonly schemaVersion: 1;
  readonly metadata: Readonly<{
    name: 'distributed-wagering-load';
    seed: string;
    runId: string;
    generatedAt: string;
    measurementDurationMs: number;
    warmupDurationMs: number;
    concurrency: number;
    processCount: number;
  }>;
  readonly environment: Readonly<{
    platform: string;
    architecture: string;
    bunVersion: string;
    dockerMode: 'direct' | 'wsl' | 'unknown';
  }>;
  readonly traffic: Readonly<{
    attempted: number;
    completed: number;
    http: number;
    sqs: number;
    terminalLatencyMs: readonly number[];
  }>;
  readonly outcomes: Readonly<{
    processed: number;
    rejected: number;
    pendingReference: number;
    idempotentReplay: number;
    conflict: number;
    failed: number;
    transientError: number;
    unexpectedError: number;
    sqsAccepted: number;
  }>;
  readonly samples: readonly LoadSample[];
}

export interface LoadArtifactPaths {
  readonly directory: string;
  readonly executionJson: string;
  readonly reportJson: string;
  readonly reportMarkdown: string;
}

const DEFAULT_OPERATION_COUNT = 300;
const DEFAULT_OCCURRED_AT = '2026-01-01T00:00:00.000Z';
const DEFAULT_CONCURRENCY = 24;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const DEFAULT_RUN_TIMEOUT_MS = 90_000;
const LOAD_AMOUNT = '1.00';
const LOAD_CURRENCY = 'BRL';
const SAFE_ARTIFACT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function resolveLoadArtifactPaths(root: string, runId: string): LoadArtifactPaths {
  if (!SAFE_ARTIFACT_IDENTIFIER.test(runId)) {
    throw new TypeError('runId must be a safe artifact identifier');
  }
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '');
  if (normalizedRoot.length === 0) {
    throw new TypeError('artifact root must not be empty');
  }
  const directory = `${normalizedRoot}/${runId}`;
  return Object.freeze({
    directory,
    executionJson: `${directory}/execution.json`,
    reportJson: `${directory}/report.json`,
    reportMarkdown: `${directory}/report.md`,
  });
}

export async function writeLoadExecutionArtifact(
  result: LoadExecutionResult,
  root = 'artifacts/load',
): Promise<LoadArtifactPaths> {
  const paths = resolveLoadArtifactPaths(root, result.metadata.runId);
  await mkdir(paths.directory, { recursive: true });
  await Bun.write(paths.executionJson, `${JSON.stringify(result, null, 2)}\n`);
  return paths;
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function deterministicHex(seed: string, label: string): string {
  return createHash('sha256').update(`${seed}:${label}`).digest('hex');
}

function deterministicUuid(seed: string, label: string): string {
  const hexadecimal = deterministicHex(seed, label).slice(0, 32).split('');
  hexadecimal[12] = '4';
  const variant = Number.parseInt(hexadecimal[16] ?? '0', 16);
  hexadecimal[16] = ((variant & 0x3) | 0x8).toString(16);
  const compact = hexadecimal.join('');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function createRandom(seed: string): () => number {
  let state = Number.parseInt(deterministicHex(seed, 'random').slice(0, 8), 16) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffleUnits<T>(units: T[], random: () => number): T[] {
  for (let index = units.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const current = units[index];
    const replacement = units[other];
    if (current !== undefined && replacement !== undefined) {
      units[index] = replacement;
      units[other] = current;
    }
  }
  return units;
}

function createProfile(operationCount: number): LoadPlan['profile'] {
  const exactDuplicate = Math.floor(operationCount * 0.2);
  const independentWallet = Math.floor(operationCount * 0.15);
  let outOfOrderReference = Math.floor(operationCount * 0.1);
  if (outOfOrderReference % 2 !== 0) {
    outOfOrderReference -= 1;
  }
  const hotWallet = operationCount - exactDuplicate - independentWallet - outOfOrderReference;
  return Object.freeze({ hotWallet, exactDuplicate, independentWallet, outOfOrderReference });
}

function createCommand(
  seed: string,
  namespace: string,
  target: LoadWalletTarget,
  providerId: string,
  kind: LoadWagerKind,
  referenceExternalTransactionId?: string,
): LoadBusinessCommand {
  const identity = deterministicHex(seed, namespace).slice(0, 24);
  return Object.freeze({
    providerId,
    externalTransactionId: `${namespace}-${identity}`,
    idempotencyKey: `${namespace}-${identity}`,
    playerId: target.playerId,
    walletId: target.walletId,
    roundId: `round-${identity}`,
    gameId: 'distributed-load-game',
    kind,
    money: Object.freeze({ amount: LOAD_AMOUNT, currency: LOAD_CURRENCY }),
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
  });
}

function createOperation(
  seed: string,
  runNamespace: string,
  index: number,
  scenario: LoadScenario,
  transport: LoadTransport,
  command: LoadBusinessCommand,
  occurredAt: string,
  afterOperationId?: string,
): LoadOperation {
  const operationId = deterministicUuid(seed, `${runNamespace}:operation:${String(index)}`);
  const messageId = deterministicUuid(seed, `${runNamespace}:message:${String(index)}`);
  return Object.freeze({
    operationId,
    scenario,
    transport,
    command,
    envelope: Object.freeze({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt,
      data: command,
    }),
    ...(afterOperationId === undefined ? {} : { afterOperationId }),
  });
}

function assertPlanConfiguration(configuration: LoadPlanConfiguration): void {
  assertNonEmpty(configuration.seed, 'seed');
  assertNonEmpty(configuration.runId, 'runId');
  assertNonEmpty(configuration.hotWallet.walletId, 'hotWallet.walletId');
  assertNonEmpty(configuration.hotWallet.playerId, 'hotWallet.playerId');
  if (configuration.independentWallets.length === 0) {
    throw new TypeError('independentWallets must contain at least one target');
  }
  const operationCount = configuration.operationCount ?? DEFAULT_OPERATION_COUNT;
  assertPositiveInteger(operationCount, 'operationCount');
  if (operationCount < 20) {
    throw new TypeError('operationCount must be at least 20');
  }
  const occurredAt = configuration.occurredAt ?? DEFAULT_OCCURRED_AT;
  if (new Date(occurredAt).toISOString() !== occurredAt) {
    throw new TypeError('occurredAt must be an exact ISO-8601 timestamp');
  }
}

export function createLoadPlan(configuration: LoadPlanConfiguration): LoadPlan {
  assertPlanConfiguration(configuration);
  const operationCount = configuration.operationCount ?? DEFAULT_OPERATION_COUNT;
  const occurredAt = configuration.occurredAt ?? DEFAULT_OCCURRED_AT;
  const profile = createProfile(operationCount);
  const runNamespace = `${configuration.runId}-${deterministicHex(configuration.seed, configuration.runId).slice(0, 12)}`;
  const providerId =
    configuration.providerId ??
    `load-provider-${deterministicHex(configuration.seed, `${configuration.runId}:provider`).slice(0, 16)}`;
  const random = createRandom(`${configuration.seed}:${configuration.runId}`);
  const units: LoadOperation[][] = [];
  let operationIndex = 0;

  for (let index = 0; index < profile.hotWallet; index += 1) {
    const command = createCommand(
      configuration.seed,
      `${runNamespace}-hot-${String(index)}`,
      configuration.hotWallet,
      providerId,
      'BET',
    );
    units.push([
      createOperation(
        configuration.seed,
        runNamespace,
        operationIndex,
        'hot_wallet',
        random() < 0.5 ? 'http' : 'sqs',
        command,
        occurredAt,
      ),
    ]);
    operationIndex += 1;
  }

  const duplicateCommand = createCommand(
    configuration.seed,
    `${runNamespace}-duplicate`,
    configuration.hotWallet,
    providerId,
    'BET',
  );
  for (let index = 0; index < profile.exactDuplicate; index += 1) {
    units.push([
      createOperation(
        configuration.seed,
        runNamespace,
        operationIndex,
        'exact_duplicate',
        index % 2 === 0 ? 'http' : 'sqs',
        duplicateCommand,
        occurredAt,
      ),
    ]);
    operationIndex += 1;
  }

  const independentKinds: readonly LoadWagerKind[] = ['BET', 'WIN', 'LOSS'];
  for (let index = 0; index < profile.independentWallet; index += 1) {
    const target =
      configuration.independentWallets[index % configuration.independentWallets.length];
    const kind = independentKinds[index % independentKinds.length];
    if (target === undefined || kind === undefined) {
      throw new TypeError('Independent load target could not be selected');
    }
    const command = createCommand(
      configuration.seed,
      `${runNamespace}-independent-${String(index)}`,
      target,
      providerId,
      kind,
    );
    units.push([
      createOperation(
        configuration.seed,
        runNamespace,
        operationIndex,
        'independent_wallet',
        random() < 0.5 ? 'http' : 'sqs',
        command,
        occurredAt,
      ),
    ]);
    operationIndex += 1;
  }

  for (let pairIndex = 0; pairIndex < profile.outOfOrderReference / 2; pairIndex += 1) {
    const source = createCommand(
      configuration.seed,
      `${runNamespace}-reference-${String(pairIndex)}`,
      configuration.hotWallet,
      providerId,
      'BET',
    );
    const reversal = Object.freeze({
      ...createCommand(
        configuration.seed,
        `${runNamespace}-reversal-${String(pairIndex)}`,
        configuration.hotWallet,
        providerId,
        'REFUND',
        source.externalTransactionId,
      ),
      roundId: source.roundId,
      gameId: source.gameId,
      money: source.money,
    });
    const reversalOperation = createOperation(
      configuration.seed,
      runNamespace,
      operationIndex,
      'out_of_order_reference',
      'http',
      reversal,
      occurredAt,
    );
    operationIndex += 1;
    const sourceOperation = createOperation(
      configuration.seed,
      runNamespace,
      operationIndex,
      'out_of_order_reference',
      'sqs',
      source,
      occurredAt,
      reversalOperation.operationId,
    );
    operationIndex += 1;
    units.push([reversalOperation, sourceOperation]);
  }

  const operations = Object.freeze(shuffleUnits(units, random).flat());
  return Object.freeze({
    schemaVersion: 1,
    seed: configuration.seed,
    runId: configuration.runId,
    profile,
    operations,
  });
}

function createOutcomeCounts(): MutableOutcomeCounts {
  return {
    processed: 0,
    rejected: 0,
    pendingReference: 0,
    idempotentReplay: 0,
    conflict: 0,
    failed: 0,
    transientError: 0,
    unexpectedError: 0,
    sqsAccepted: 0,
  };
}

interface MutableOutcomeCounts {
  processed: number;
  rejected: number;
  pendingReference: number;
  idempotentReplay: number;
  conflict: number;
  failed: number;
  transientError: number;
  unexpectedError: number;
  sqsAccepted: number;
}

function incrementOutcome(counts: MutableOutcomeCounts, result: LoadDispatchResult): void {
  if (result.idempotentReplay === true || result.outcome === 'idempotent_replay') {
    counts.idempotentReplay += 1;
    return;
  }
  const keys: Record<LoadOutcome, keyof MutableOutcomeCounts> = {
    processed: 'processed',
    rejected: 'rejected',
    pending_reference: 'pendingReference',
    idempotent_replay: 'idempotentReplay',
    conflict: 'conflict',
    failed: 'failed',
    transient_error: 'transientError',
    unexpected_error: 'unexpectedError',
    sqs_accepted: 'sqsAccepted',
  };
  counts[keys[result.outcome]] += 1;
}

function timeoutAfter(milliseconds: number, controller: AbortController): Promise<never> {
  return new Promise((_, reject) => {
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Load operation timed out'));
    }, milliseconds);
    controller.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
      },
      { once: true },
    );
  });
}

function createSample(
  operation: LoadOperation,
  result: LoadDispatchResult,
  latencyMs: number,
): LoadSample {
  return Object.freeze({
    operationId: operation.operationId,
    scenario: operation.scenario,
    transport: operation.transport,
    kind: operation.command.kind,
    outcome: result.idempotentReplay === true ? 'idempotent_replay' : result.outcome,
    ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
    latencyMs,
  });
}

export async function executeLoadPlan(
  plan: LoadPlan,
  dispatchers: LoadDispatchers,
  configuration: LoadExecutionConfiguration = {},
): Promise<LoadExecutionResult> {
  const concurrency = configuration.concurrency ?? DEFAULT_CONCURRENCY;
  const operationTimeoutMs = configuration.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const runTimeoutMs = configuration.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  assertPositiveInteger(concurrency, 'concurrency');
  assertPositiveInteger(operationTimeoutMs, 'operationTimeoutMs');
  assertPositiveInteger(runTimeoutMs, 'runTimeoutMs');

  const startedAt = performance.now();
  const samples: LoadSample[] = [];
  const outcomeCounts = createOutcomeCounts();
  const completionResolvers = new Map<string, () => void>();
  const completionPromises = new Map<string, Promise<void>>();
  for (const operation of plan.operations) {
    completionPromises.set(
      operation.operationId,
      new Promise((resolve) => {
        completionResolvers.set(operation.operationId, resolve);
      }),
    );
  }
  const runController = new AbortController();
  const runTimer = setTimeout(() => {
    runController.abort();
  }, runTimeoutMs);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (!runController.signal.aborted) {
      const index = cursor;
      cursor += 1;
      const operation = plan.operations[index];
      if (operation === undefined) {
        return;
      }
      if (operation.afterOperationId !== undefined) {
        const dependency = completionPromises.get(operation.afterOperationId);
        if (dependency === undefined) {
          throw new TypeError(`Load operation ${operation.operationId} has an unknown dependency`);
        }
        await dependency;
      }
      const operationController = new AbortController();
      const abortFromRun = () => {
        operationController.abort();
      };
      runController.signal.addEventListener('abort', abortFromRun, { once: true });
      const operationStartedAt = performance.now();
      let result: LoadDispatchResult;
      try {
        result = await Promise.race([
          dispatchers[operation.transport](operation, operationController.signal),
          timeoutAfter(operationTimeoutMs, operationController),
        ]);
      } catch {
        result = { outcome: 'transient_error' };
      } finally {
        operationController.abort();
        runController.signal.removeEventListener('abort', abortFromRun);
      }
      const latencyMs = performance.now() - operationStartedAt;
      incrementOutcome(outcomeCounts, result);
      samples.push(createSample(operation, result, latencyMs));
      completionResolvers.get(operation.operationId)?.();
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, plan.operations.length) }, () => worker()),
    );
  } finally {
    clearTimeout(runTimer);
  }

  if (runController.signal.aborted && samples.length < plan.operations.length) {
    throw new Error(
      `Load execution exceeded its ${String(runTimeoutMs)} ms deadline after ${String(samples.length)} operations`,
    );
  }

  samples.sort((left, right) => left.operationId.localeCompare(right.operationId));
  const durationMs = performance.now() - startedAt;
  const terminalSamples = samples.filter(
    (sample) => sample.outcome !== 'transient_error' && sample.outcome !== 'unexpected_error',
  );
  const terminalLatencyMs = terminalSamples.map((sample) => sample.latencyMs);

  return Object.freeze({
    schemaVersion: 1,
    metadata: Object.freeze({
      name: 'distributed-wagering-load',
      seed: plan.seed,
      runId: plan.runId,
      generatedAt: new Date().toISOString(),
      measurementDurationMs: durationMs,
      warmupDurationMs: configuration.warmupDurationMs ?? 0,
      concurrency,
      processCount: configuration.processCount ?? 3,
    }),
    environment: Object.freeze({
      platform: process.platform,
      architecture: process.arch,
      bunVersion: Bun.version,
      dockerMode: configuration.dockerMode ?? 'unknown',
    }),
    traffic: Object.freeze({
      attempted: plan.operations.length,
      completed: terminalSamples.length,
      http: plan.operations.filter((operation) => operation.transport === 'http').length,
      sqs: plan.operations.filter((operation) => operation.transport === 'sqs').length,
      terminalLatencyMs: Object.freeze(terminalLatencyMs),
    }),
    outcomes: Object.freeze({ ...outcomeCounts }),
    samples: Object.freeze(samples),
  });
}

function classifyHttpResponse(statusCode: number, body: unknown): LoadDispatchResult {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (record.idempotentReplay === true) {
    return { outcome: 'idempotent_replay', statusCode, idempotentReplay: true };
  }
  if (statusCode === 202 || record.status === 'PENDING_REFERENCE') {
    return { outcome: 'pending_reference', statusCode };
  }
  if (statusCode === 409) {
    return { outcome: 'conflict', statusCode };
  }
  if (statusCode === 422 || record.status === 'REJECTED') {
    return { outcome: 'rejected', statusCode };
  }
  if (record.status === 'FAILED') {
    return { outcome: 'failed', statusCode };
  }
  if (statusCode >= 200 && statusCode < 300) {
    return { outcome: 'processed', statusCode };
  }
  if (statusCode === 503 || statusCode === 429) {
    return { outcome: 'transient_error', statusCode };
  }
  return { outcome: 'unexpected_error', statusCode };
}

export function createHttpDispatcher(baseUrls: readonly string[]): LoadDispatcher {
  if (baseUrls.length === 0) {
    throw new TypeError('At least one HTTP base URL is required');
  }
  const normalized = baseUrls.map((baseUrl) => baseUrl.replace(/\/$/, ''));
  return async (operation, signal) => {
    const index =
      Number.parseInt(deterministicHex(operation.operationId, 'http-target').slice(0, 8), 16) %
      normalized.length;
    const baseUrl = normalized[index];
    if (baseUrl === undefined) {
      throw new TypeError('HTTP target could not be selected');
    }
    const { idempotencyKey, ...body } = operation.command;
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-correlation-id': operation.operationId,
      },
      body: JSON.stringify(body),
      signal,
    });
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = undefined;
    }
    return classifyHttpResponse(response.status, responseBody);
  };
}

export function createSqsDispatcher(client: SQSClient, commandQueueUrl: string): LoadDispatcher {
  assertNonEmpty(commandQueueUrl, 'commandQueueUrl');
  return async (operation, signal) => {
    await client.send(
      new SendMessageCommand({
        QueueUrl: commandQueueUrl,
        MessageBody: JSON.stringify(operation.envelope),
        MessageGroupId: operation.command.walletId,
        MessageDeduplicationId: operation.envelope.messageId,
      }),
      { abortSignal: signal },
    );
    return { outcome: 'sqs_accepted' };
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function parseIndependentWallets(value: string): readonly LoadWalletTarget[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new TypeError('LOAD_INDEPENDENT_WALLETS must be a JSON array');
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`Independent wallet at index ${String(index)} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.walletId !== 'string' || typeof record.playerId !== 'string') {
      throw new TypeError(
        `Independent wallet at index ${String(index)} requires walletId and playerId`,
      );
    }
    return Object.freeze({ walletId: record.walletId, playerId: record.playerId });
  });
}

export async function runLoadCli(): Promise<void> {
  const seed = process.env.LOAD_SEED ?? 'jungle-distributed-load';
  const runId = process.env.LOAD_RUN_ID ?? deterministicUuid(seed, new Date().toISOString());
  const baseUrls = requiredEnvironment('LOAD_BASE_URLS')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(process.env.SQS_ENDPOINT === undefined ? {} : { endpoint: process.env.SQS_ENDPOINT }),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  try {
    const plan = createLoadPlan({
      seed,
      runId,
      operationCount: Number(process.env.LOAD_OPERATION_COUNT ?? DEFAULT_OPERATION_COUNT),
      occurredAt: new Date().toISOString(),
      hotWallet: {
        walletId: requiredEnvironment('LOAD_HOT_WALLET_ID'),
        playerId: requiredEnvironment('LOAD_HOT_PLAYER_ID'),
      },
      independentWallets: parseIndependentWallets(requiredEnvironment('LOAD_INDEPENDENT_WALLETS')),
    });
    const result = await executeLoadPlan(
      plan,
      {
        http: createHttpDispatcher(baseUrls),
        sqs: createSqsDispatcher(client, requiredEnvironment('SQS_COMMAND_QUEUE_URL')),
      },
      {
        concurrency: Number(process.env.LOAD_CONCURRENCY ?? DEFAULT_CONCURRENCY),
        operationTimeoutMs: Number(
          process.env.LOAD_OPERATION_TIMEOUT_MS ?? DEFAULT_OPERATION_TIMEOUT_MS,
        ),
        runTimeoutMs: Number(process.env.LOAD_RUN_TIMEOUT_MS ?? DEFAULT_RUN_TIMEOUT_MS),
        processCount: baseUrls.length,
        dockerMode:
          process.env.LOAD_DOCKER_MODE === 'direct' || process.env.LOAD_DOCKER_MODE === 'wsl'
            ? process.env.LOAD_DOCKER_MODE
            : 'unknown',
      },
    );
    await writeLoadExecutionArtifact(result, process.env.LOAD_ARTIFACT_ROOT ?? 'artifacts/load');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    client.destroy();
  }
}

if (import.meta.main) {
  await runLoadCli();
}
