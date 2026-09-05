import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';

import { createSqsClient } from '../../src/messaging/infrastructure/sqs-client.factory.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import { createTestEnvironment } from '../support/test-environment.js';

const PROCESS_CONFIGURATION_VARIABLE = 'OUTBOX_PUBLISHER_CRASH_CONFIGURATION';
const PUBLISHER_PROCESS_SCRIPT = `
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from './src/bootstrap/configuration/mikro-orm.config.ts';
import { parseEnvironment } from './src/bootstrap/configuration/environment.schema.ts';
import { MikroOrmTransactionRunner } from './src/shared/infrastructure/mikro-orm-transaction-runner.ts';
import { MikroOrmOutboxRepository } from './src/messaging/infrastructure/outbox.repository.ts';
import { createSqsClient } from './src/messaging/infrastructure/sqs-client.factory.ts';
import { SqsIntegrationEventPublisher } from './src/messaging/infrastructure/integration-event.publisher.ts';
import { OutboxWorker } from './src/messaging/infrastructure/outbox.worker.ts';

const configuration = JSON.parse(process.env.${PROCESS_CONFIGURATION_VARIABLE});
const environment = parseEnvironment(configuration.environment);

function writeMarker(event) {
  return new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify({ event }) + '\\n', (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

class ProcessFailpoints {
  async trigger(name) {
    const crashAfterClaim =
      configuration.mode === 'crash-after-claim' &&
      name === 'after_outbox_claim_before_publish';
    const crashAfterPublish =
      configuration.mode === 'crash-after-publish' &&
      name === 'after_sqs_publish_before_outbox_mark_published';
    if (!crashAfterClaim && !crashAfterPublish) {
      return;
    }

    await writeMarker(name);
    process.exit(crashAfterClaim ? 86 : 87);
  }
}

const orm = await MikroORM.init(createMikroOrmConfig(environment));
const sqsClient = createSqsClient(environment);

try {
  const transactionRunner = new MikroOrmTransactionRunner(orm, (entityManager) => ({
    outbox: new MikroOrmOutboxRepository(entityManager),
  }));
  const publisher = new SqsIntegrationEventPublisher(sqsClient, configuration.eventQueueUrl);
  const worker = new OutboxWorker(transactionRunner, publisher, {
    batchSize: 1,
    leaseDurationMs: configuration.leaseDurationMs,
    failpoints: new ProcessFailpoints(),
  });
  await worker.runOnce();
  await writeMarker('FINISHED');
} finally {
  sqsClient.destroy();
  await orm.close(true);
}
`;

type PublisherMode = 'crash-after-claim' | 'crash-after-publish' | 'normal';

interface IsolatedEventQueue {
  readonly queueUrl: string;
  delete(): Promise<void>;
}

interface PersistedEvent {
  readonly aggregateId: string;
  readonly eventId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface ProcessResult {
  readonly exitCode: number;
  readonly markers: readonly string[];
  readonly standardError: string;
}

interface OutboxState {
  readonly lease_expires_at: Date | null;
  readonly lease_token: string | null;
  readonly published_at: Date | null;
}

let databaseContext: DatabaseTestContext | undefined;
let eventQueue: IsolatedEventQueue | undefined;
const testEnvironment = createTestEnvironment();
const sqsClient = createSqsClient(testEnvironment.configuration);

setDefaultTimeout(120_000);

function context(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

function queue(): IsolatedEventQueue {
  if (eventQueue === undefined) {
    throw new Error('Event queue is unavailable');
  }
  return eventQueue;
}

async function createIsolatedEventQueue(
  client: SQSClient,
  prefix: string,
): Promise<IsolatedEventQueue> {
  const queueName = `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12)}.fifo`;
  await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        ContentBasedDeduplication: 'false',
        FifoQueue: 'true',
        ReceiveMessageWaitTimeSeconds: '1',
      },
    }),
  );
  const queueUrl = (await client.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl;
  if (queueUrl === undefined) {
    throw new Error('Event queue URL is unavailable');
  }

  return Object.freeze({
    queueUrl,
    delete: async () => {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    },
  });
}

async function insertEvent(eventType: string): Promise<PersistedEvent> {
  const aggregateId = randomUUID();
  const eventId = randomUUID();
  const occurredAt = new Date(Date.now() - 5_000);
  const correlationId = randomUUID();
  const payload = Object.freeze({
    eventId,
    eventType,
    version: 1,
    occurredAt: occurredAt.toISOString(),
    aggregateId,
    correlationId,
    data: Object.freeze({ walletId: aggregateId }),
  });
  await context()
    .orm.em.getConnection()
    .execute(
      `insert into outbox_messages
         (id, event_id, aggregate_id, event_type, version, payload, correlation_id,
          causation_id, occurred_at, attempts, next_attempt_at, lease_token,
          lease_expires_at, published_at)
       values (?, ?, ?, ?, 1, ?::jsonb, ?, null, ?, 0, ?, null, null, null)`,
      [
        randomUUID(),
        eventId,
        aggregateId,
        eventType,
        JSON.stringify(payload),
        correlationId,
        occurredAt,
        new Date(occurredAt.getTime() - 1_000),
      ],
    );
  return Object.freeze({ aggregateId, eventId, payload });
}

async function runPublisherProcess(
  mode: PublisherMode,
  leaseDurationMs: number,
): Promise<ProcessResult> {
  const environment = createTestEnvironment({
    DATABASE_NAME: context().databaseName,
    SQS_EVENT_QUEUE_URL: queue().queueUrl,
  });
  const handle = Bun.spawn({
    cmd: [process.execPath, '--eval', PUBLISHER_PROCESS_SCRIPT],
    cwd: process.cwd(),
    env: {
      ...process.env,
      [PROCESS_CONFIGURATION_VARIABLE]: JSON.stringify({
        environment: environment.variables,
        eventQueueUrl: queue().queueUrl,
        leaseDurationMs,
        mode,
      }),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [standardOutput, standardError, exitCode] = await Promise.all([
    new Response(handle.stdout).text(),
    new Response(handle.stderr).text(),
    handle.exited,
  ]);
  const markers = standardOutput
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as { readonly event?: unknown };
        return typeof value.event === 'string' ? [value.event] : [];
      } catch {
        return [];
      }
    });

  return Object.freeze({ exitCode, markers, standardError });
}

async function readOutboxState(eventId: string): Promise<OutboxState> {
  const rows = await context()
    .orm.em.getConnection()
    .execute<OutboxState[]>(
      `select lease_token, lease_expires_at, published_at
         from outbox_messages
        where event_id = ?`,
      [eventId],
    );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Outbox event ${eventId} is unavailable`);
  }
  return row;
}

async function receiveEnvelope(waitTimeSeconds = 1): Promise<Record<string, unknown> | null> {
  const response = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: queue().queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: waitTimeSeconds,
    }),
  );
  const message = response.Messages?.[0];
  if (message?.Body === undefined || message.ReceiptHandle === undefined) {
    return null;
  }
  await sqsClient.send(
    new DeleteMessageCommand({
      QueueUrl: queue().queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    }),
  );
  return JSON.parse(message.Body) as Record<string, unknown>;
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('outbox_publication_crash');
  await databaseContext.orm.migrator.up();
  eventQueue = await createIsolatedEventQueue(sqsClient, 'outbox-publication-crash');
});

afterAll(async () => {
  await eventQueue?.delete();
  sqsClient.destroy();
  await databaseContext?.close();
});

test('recovers real publisher crashes before and after SQS publication', async () => {
  const leaseDurationMs = 500;
  const prePublishEvent = await insertEvent('WalletOpened');

  const prePublishCrash = await runPublisherProcess('crash-after-claim', leaseDurationMs);
  expect(prePublishCrash.standardError).toBe('');
  expect(prePublishCrash.exitCode).toBe(86);
  expect(prePublishCrash.markers).toContain('after_outbox_claim_before_publish');
  expect(await receiveEnvelope(0)).toBeNull();

  const prePublishCrashedState = await readOutboxState(prePublishEvent.eventId);
  expect(prePublishCrashedState.published_at).toBeNull();
  expect(prePublishCrashedState.lease_token).not.toBeNull();
  expect(prePublishCrashedState.lease_expires_at).not.toBeNull();

  await Bun.sleep(leaseDurationMs + 250);
  const prePublishRecovery = await runPublisherProcess('normal', leaseDurationMs);
  expect(prePublishRecovery).toMatchObject({ exitCode: 0, markers: ['FINISHED'] });
  const recoveredBeforePublish = await readOutboxState(prePublishEvent.eventId);
  expect(recoveredBeforePublish).toMatchObject({
    lease_token: null,
    lease_expires_at: null,
  });
  expect(recoveredBeforePublish.published_at).not.toBeNull();
  expect(await receiveEnvelope()).toEqual(prePublishEvent.payload);

  const postPublishEvent = await insertEvent('WalletBalanceChanged');
  const postPublishCrash = await runPublisherProcess('crash-after-publish', leaseDurationMs);
  expect(postPublishCrash.standardError).toBe('');
  expect(postPublishCrash.exitCode).toBe(87);
  expect(postPublishCrash.markers).toContain('after_sqs_publish_before_outbox_mark_published');
  expect(await receiveEnvelope()).toEqual(postPublishEvent.payload);

  const postPublishCrashedState = await readOutboxState(postPublishEvent.eventId);
  expect(postPublishCrashedState.published_at).toBeNull();
  expect(postPublishCrashedState.lease_token).not.toBeNull();
  expect(postPublishCrashedState.lease_expires_at).not.toBeNull();

  await Bun.sleep(leaseDurationMs + 250);
  const postPublishRecovery = await runPublisherProcess('normal', leaseDurationMs);
  expect(postPublishRecovery).toMatchObject({ exitCode: 0, markers: ['FINISHED'] });
  const recoveredAfterPublish = await readOutboxState(postPublishEvent.eventId);
  expect(recoveredAfterPublish).toMatchObject({
    lease_token: null,
    lease_expires_at: null,
  });
  expect(recoveredAfterPublish.published_at).not.toBeNull();

  const possibleDuplicate = await receiveEnvelope(0);
  if (possibleDuplicate !== null) {
    expect(possibleDuplicate).toEqual(postPublishEvent.payload);
  }
});
