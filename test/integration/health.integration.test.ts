import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Module, type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { createSqsClient } from '../../src/messaging/infrastructure/sqs-client.factory.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import { createTestEnvironment } from '../support/test-environment.js';

const HEALTH_SERVICE_MODULE_PATH = '../../src/health/application/health.service.js';
const READINESS_PROBES_MODULE_PATH = '../../src/health/infrastructure/readiness.probes.js';
const HEALTH_CONTROLLER_MODULE_PATH = '../../src/health/presentation/health.controller.js';

interface ReadinessProbe {
  check(): Promise<void>;
}

interface HealthServiceOptions {
  readonly database: ReadinessProbe;
  readonly sqs: ReadinessProbe;
  readonly timeoutMs: number;
}

interface HealthServiceContract {
  checkReadiness(): Promise<Record<string, unknown>>;
}

type HealthServiceConstructor = Type<HealthServiceContract> &
  (new (options: HealthServiceOptions) => HealthServiceContract);
type PostgresReadinessProbeConstructor = new (orm: MikroORM) => ReadinessProbe;
type SqsReadinessProbeConstructor = new (sqsClient: SQSClient, queueUrl: string) => ReadinessProbe;

interface IsolatedQueue {
  readonly queueUrl: string;
  delete(): Promise<void>;
}

let databaseContext: DatabaseTestContext | undefined;
let isolatedQueue: IsolatedQueue | undefined;
let healthyApplication: INestApplication | undefined;
let healthyBaseUrl: string;
let healthServiceType: HealthServiceConstructor | undefined;
let healthControllerType: Type<unknown> | undefined;
let postgresReadinessProbeType: PostgresReadinessProbeConstructor | undefined;
let sqsReadinessProbeType: SqsReadinessProbeConstructor | undefined;
const sqsCommands: string[] = [];
let captureSqsCommands = false;
const testEnvironment = createTestEnvironment();
const sqsClient = createSqsClient(testEnvironment.configuration);

setDefaultTimeout(30_000);

function context(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

function queue(): IsolatedQueue {
  if (isolatedQueue === undefined) {
    throw new Error('Health test queue is unavailable');
  }
  return isolatedQueue;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function requiredConstructor(module: unknown, exportName: string): unknown {
  const candidate = asRecord(module)[exportName];
  if (typeof candidate !== 'function') {
    throw new TypeError(`${exportName} export is unavailable`);
  }
  return candidate;
}

function HealthService(): HealthServiceConstructor {
  if (healthServiceType === undefined) {
    throw new Error('HealthService is unavailable');
  }
  return healthServiceType;
}

function HealthController(): Type<unknown> {
  if (healthControllerType === undefined) {
    throw new Error('HealthController is unavailable');
  }
  return healthControllerType;
}

function PostgresReadinessProbe(): PostgresReadinessProbeConstructor {
  if (postgresReadinessProbeType === undefined) {
    throw new Error('PostgresReadinessProbe is unavailable');
  }
  return postgresReadinessProbeType;
}

function SqsReadinessProbe(): SqsReadinessProbeConstructor {
  if (sqsReadinessProbeType === undefined) {
    throw new Error('SqsReadinessProbe is unavailable');
  }
  return sqsReadinessProbeType;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return asRecord((await response.json()) as unknown);
}

async function createIsolatedQueue(client: SQSClient): Promise<IsolatedQueue> {
  const queueName = `health-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await client.send(new CreateQueueCommand({ QueueName: queueName }));
  const queueUrl = (await client.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl;
  if (queueUrl === undefined) {
    throw new Error('Health test queue URL is unavailable');
  }
  return Object.freeze({
    queueUrl,
    delete: async () => {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    },
  });
}

async function startHealthApplication(service: HealthServiceContract): Promise<INestApplication> {
  const healthService = HealthService();
  const healthController = HealthController();
  @Module({
    controllers: [healthController],
    providers: [{ provide: healthService, useValue: service }],
  })
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest uses this class as a module metadata root.
  class HealthTestModule {}

  const application = await NestFactory.create(HealthTestModule, { logger: false });
  await application.listen(0, '127.0.0.1');
  return application;
}

function successfulProbe(): ReadinessProbe {
  return Object.freeze({ check: () => Promise.resolve() });
}

function failingProbe(message: string): ReadinessProbe {
  return Object.freeze({ check: () => Promise.reject(new Error(message)) });
}

function hangingProbe(): ReadinessProbe {
  return Object.freeze({ check: () => new Promise<void>(() => undefined) });
}

beforeAll(async () => {
  const [healthServiceModule, readinessProbesModule, healthControllerModule] = await Promise.all([
    import(HEALTH_SERVICE_MODULE_PATH) as Promise<unknown>,
    import(READINESS_PROBES_MODULE_PATH) as Promise<unknown>,
    import(HEALTH_CONTROLLER_MODULE_PATH) as Promise<unknown>,
  ]);
  healthServiceType = requiredConstructor(
    healthServiceModule,
    'HealthService',
  ) as HealthServiceConstructor;
  healthControllerType = requiredConstructor(
    healthControllerModule,
    'HealthController',
  ) as Type<unknown>;
  postgresReadinessProbeType = requiredConstructor(
    readinessProbesModule,
    'PostgresReadinessProbe',
  ) as PostgresReadinessProbeConstructor;
  sqsReadinessProbeType = requiredConstructor(
    readinessProbesModule,
    'SqsReadinessProbe',
  ) as SqsReadinessProbeConstructor;

  databaseContext = await createDatabaseTestContext('health_integration');
  await databaseContext.orm.migrator.up();
  isolatedQueue = await createIsolatedQueue(sqsClient);
  sqsClient.middlewareStack.add(
    (next, middlewareContext) => async (arguments_) => {
      if (captureSqsCommands) {
        sqsCommands.push(middlewareContext.commandName ?? 'unknown');
      }
      return next(arguments_);
    },
    { name: 'captureHealthReadinessCommands', step: 'initialize' },
  );

  const Health = HealthService();
  const PostgresProbe = PostgresReadinessProbe();
  const SqsProbe = SqsReadinessProbe();
  const service = new Health({
    database: new PostgresProbe(context().orm),
    sqs: new SqsProbe(sqsClient, isolatedQueue.queueUrl),
    timeoutMs: 250,
  });
  healthyApplication = await startHealthApplication(service);
  healthyBaseUrl = await healthyApplication.getUrl();
});

afterAll(async () => {
  await healthyApplication?.close();
  await isolatedQueue?.delete();
  sqsClient.destroy();
  await databaseContext?.close();
});

describe('public health endpoints', () => {
  test('keeps liveness public and independent from dependency probes', async () => {
    const application = await startHealthApplication(
      new (HealthService())({
        database: failingProbe('postgres://user:password@database/private'),
        sqs: hangingProbe(),
        timeoutMs: 50,
      }),
    );

    try {
      const response = await fetch(`${await application.getUrl()}/health/live`);
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ status: 'ok' });
    } finally {
      await application.close();
    }
  });

  test('reports real PostgreSQL and LocalStack readiness without consuming queue data', async () => {
    const sentinelBody = JSON.stringify({ sentinel: randomUUID() });
    await sqsClient.send(
      new SendMessageCommand({ QueueUrl: queue().queueUrl, MessageBody: sentinelBody }),
    );
    sqsCommands.length = 0;
    captureSqsCommands = true;
    const response = await fetch(`${healthyBaseUrl}/health/ready`);
    captureSqsCommands = false;

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      status: 'ready',
      checks: {
        database: { status: 'up' },
        sqs: { status: 'up' },
      },
    });
    expect(sqsCommands).toEqual(['GetQueueAttributesCommand']);

    const received = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queue().queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    const message = received.Messages?.[0];
    if (message?.ReceiptHandle === undefined) {
      throw new Error('Readiness probe consumed or hid the sentinel message');
    }
    expect(message.Body).toBe(sentinelBody);
    expect(message.ReceiptHandle).toBeString();
    await sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: queue().queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  });
});

describe('readiness failure isolation', () => {
  test('reports database and SQS failures independently', async () => {
    const databaseUnavailable = await new (HealthService())({
      database: failingProbe('password=database-secret'),
      sqs: successfulProbe(),
      timeoutMs: 100,
    }).checkReadiness();
    expect(databaseUnavailable).toEqual({
      status: 'not_ready',
      checks: {
        database: { status: 'down' },
        sqs: { status: 'up' },
      },
    });

    const sqsUnavailable = await new (HealthService())({
      database: successfulProbe(),
      sqs: failingProbe('https://queue.internal/receipt/private'),
      timeoutMs: 100,
    }).checkReadiness();
    expect(sqsUnavailable).toEqual({
      status: 'not_ready',
      checks: {
        database: { status: 'up' },
        sqs: { status: 'down' },
      },
    });
  });

  test('bounds both dependency checks independently and redacts combined failures', async () => {
    const service = new (HealthService())({
      database: hangingProbe(),
      sqs: failingProbe('AuthorizationHeader=credential-secret'),
      timeoutMs: 75,
    });
    const startedAt = performance.now();
    const result = await service.checkReadiness();
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
    expect(result).toEqual({
      status: 'not_ready',
      checks: {
        database: { status: 'down' },
        sqs: { status: 'down' },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('credential-secret');
    expect(serialized).not.toContain('AuthorizationHeader');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('receipt');
  });

  test('returns HTTP 503 with safe details when both readiness dependencies fail', async () => {
    const application = await startHealthApplication(
      new (HealthService())({
        database: failingProbe('postgresql://private-user:private-password@database'),
        sqs: failingProbe('raw aws credential and queue url'),
        timeoutMs: 100,
      }),
    );

    try {
      const response = await fetch(`${await application.getUrl()}/health/ready`);
      const body = await readJson(response);
      expect(response.status).toBe(503);
      expect(body).toEqual({
        status: 'not_ready',
        checks: {
          database: { status: 'down' },
          sqs: { status: 'down' },
        },
      });
      expect(JSON.stringify(body)).not.toContain('private');
      expect(JSON.stringify(body)).not.toContain('credential');
      expect(JSON.stringify(body)).not.toContain('queue url');
    } finally {
      await application.close();
    }
  });
});
