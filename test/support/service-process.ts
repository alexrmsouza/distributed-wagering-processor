import { createTestEnvironment } from './test-environment.js';

const SERVICE_PROCESS_SCRIPT = `
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module.ts';

const application = await NestFactory.create(AppModule, { logger: false });
await application.listen(0, '127.0.0.1');
process.stdout.write('READY ' + (await application.getUrl()) + '\\n');

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await application.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
await new Promise(() => undefined);
`;

export interface TestServiceProcess {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export interface JsonHttpResponse {
  readonly response: Response;
  readonly body: Record<string, unknown>;
}

export function asJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }

  return value as Record<string, unknown>;
}

async function readReadyUrl(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(`Service process exited before readiness: ${output}`);
    }
    output += decoder.decode(value, { stream: true });
    const newline = output.indexOf('\n');
    if (newline >= 0) {
      const line = output.slice(0, newline).trim();
      if (!line.startsWith('READY ')) {
        throw new Error(`Unexpected service readiness output: ${line}`);
      }
      return line.slice('READY '.length);
    }
  }
}

export function requireTestService(
  services: readonly TestServiceProcess[],
  index: number,
): TestServiceProcess {
  const service = services.at(index);
  if (service === undefined) {
    throw new Error(`Service instance ${String(index)} is unavailable`);
  }
  return service;
}

async function startTestService(databaseName: string): Promise<TestServiceProcess> {
  const environment = createTestEnvironment({ DATABASE_NAME: databaseName });
  const processHandle = Bun.spawn({
    cmd: [process.execPath, '--eval', SERVICE_PROCESS_SCRIPT],
    cwd: process.cwd(),
    env: { ...process.env, ...environment.variables },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const baseUrl = await Promise.race([
    readReadyUrl(processHandle.stdout),
    Bun.sleep(30_000).then(() => {
      throw new Error('Timed out while starting a service process');
    }),
  ]);

  return Object.freeze({
    baseUrl,
    stop: async (): Promise<void> => {
      if (processHandle.exitCode === null) {
        processHandle.kill();
      }
      await processHandle.exited;
    },
  });
}

export async function startTestServices(
  databaseName: string,
  count: number,
): Promise<readonly TestServiceProcess[]> {
  return Promise.all(Array.from({ length: count }, () => startTestService(databaseName)));
}

async function stopTestService(service: TestServiceProcess): Promise<void> {
  await service.stop();
}

export async function stopTestServices(services: readonly TestServiceProcess[]): Promise<void> {
  await Promise.all(services.map(stopTestService));
}

export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<JsonHttpResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  return Object.freeze({ response, body: asJsonRecord((await response.json()) as unknown) });
}
