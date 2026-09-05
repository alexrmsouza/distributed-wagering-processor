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

const PROCESS_CONFIGURATION_VARIABLE = 'OUTBOX_PUBLISHER_PROCESS_CONFIGURATION';
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
  });

  for (let iteration = 0; iteration < configuration.iterations; iteration += 1) {
    await worker.runOnce();
    await Bun.sleep(25);
  }

  process.stdout.write(JSON.stringify({ event: 'FINISHED' }) + '\\n');
} finally {
  sqsClient.destroy();
  await orm.close(true);
}
`;

interface IsolatedEventQueue {
  readonly queueUrl: string;
  delete(): Promise<void>;
}

interface PersistedOutboxEvent {
  readonly aggregateId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
}

interface PublishedEnvelope {
  readonly aggregateId: string;
  readonly eventId: string;
  readonly eventType: string;
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

async function insertOutboxEvent(
  event: PersistedOutboxEvent,
  options: { readonly expiredLeaseToken?: string } = {},
): Promise<void> {
  const payload = Object.freeze({
    eventId: event.eventId,
    eventType: event.eventType,
    version: 1,
    occurredAt: event.occurredAt.toISOString(),
    aggregateId: event.aggregateId,
    correlationId: randomUUID(),
    data: Object.freeze({ walletId: event.aggregateId }),
  });
  await context()
    .orm.em.getConnection()
    .execute(
      `insert into outbox_messages
         (id, event_id, aggregate_id, event_type, version, payload, correlation_id,
          causation_id, occurred_at, attempts, next_attempt_at, lease_token,
          lease_expires_at, published_at)
       values (?, ?, ?, ?, 1, ?::jsonb, ?, null, ?, 0, ?, ?, ?, null)`,
      [
        randomUUID(),
        event.eventId,
        event.aggregateId,
        event.eventType,
        JSON.stringify(payload),
        payload.correlationId,
        event.occurredAt,
        new Date(event.occurredAt.getTime() - 1_000),
        options.expiredLeaseToken ?? null,
        options.expiredLeaseToken === undefined ? null : new Date(event.occurredAt.getTime() - 500),
      ],
    );
}

async function runPublisherProcess(): Promise<void> {
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
        iterations: 8,
        leaseDurationMs: 2_000,
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
  if (exitCode !== 0) {
    throw new Error(
      `Outbox publisher exited with ${String(exitCode)}: ${standardError || standardOutput}`,
    );
  }
}

async function receivePublishedEnvelopes(expectedCount: number): Promise<PublishedEnvelope[]> {
  const envelopes: PublishedEnvelope[] = [];
  const deadline = Date.now() + 20_000;

  while (envelopes.length < expectedCount && Date.now() < deadline) {
    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queue().queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    for (const message of response.Messages ?? []) {
      if (message.Body === undefined || message.ReceiptHandle === undefined) {
        continue;
      }
      envelopes.push(JSON.parse(message.Body) as PublishedEnvelope);
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: queue().queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
  }

  return envelopes;
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('outbox_publishers_concurrency');
  await databaseContext.orm.migrator.up();
  eventQueue = await createIsolatedEventQueue(sqsClient, 'outbox-publishers');
});

afterAll(async () => {
  await eventQueue?.delete();
  sqsClient.destroy();
  await databaseContext?.close();
});

test('competing publishers recover an expired lease while preserving aggregate order', async () => {
  const firstAggregateId = randomUUID();
  const secondAggregateId = randomUUID();
  const initialInstant = Date.now() - 10_000;
  const firstEvent: PersistedOutboxEvent = {
    aggregateId: firstAggregateId,
    eventId: randomUUID(),
    eventType: 'WalletOpened',
    occurredAt: new Date(initialInstant),
  };
  const secondEvent: PersistedOutboxEvent = {
    aggregateId: firstAggregateId,
    eventId: randomUUID(),
    eventType: 'WalletBalanceChanged',
    occurredAt: new Date(initialInstant + 1),
  };
  const independentEvent: PersistedOutboxEvent = {
    aggregateId: secondAggregateId,
    eventId: randomUUID(),
    eventType: 'WalletOpened',
    occurredAt: new Date(initialInstant + 2),
  };
  const abandonedLeaseToken = randomUUID();

  await insertOutboxEvent(firstEvent, { expiredLeaseToken: abandonedLeaseToken });
  await insertOutboxEvent(secondEvent);
  await insertOutboxEvent(independentEvent);

  await Promise.all([runPublisherProcess(), runPublisherProcess(), runPublisherProcess()]);

  const rows = await context()
    .orm.em.getConnection()
    .execute<
      {
        aggregate_id: string;
        event_id: string;
        lease_expires_at: Date | null;
        lease_token: string | null;
        published_at: Date | null;
      }[]
    >(
      `select event_id, aggregate_id, lease_token, lease_expires_at, published_at
         from outbox_messages
        where event_id in (?, ?, ?)
        order by occurred_at, id`,
      [firstEvent.eventId, secondEvent.eventId, independentEvent.eventId],
    );
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.published_at !== null)).toBe(true);
  expect(rows.every((row) => row.lease_token === null && row.lease_expires_at === null)).toBe(true);
  expect(rows.some((row) => row.lease_token === abandonedLeaseToken)).toBe(false);

  const envelopes = await receivePublishedEnvelopes(3);
  expect(envelopes).toHaveLength(3);
  expect(new Set(envelopes.map((envelope) => envelope.eventId))).toEqual(
    new Set([firstEvent.eventId, secondEvent.eventId, independentEvent.eventId]),
  );
  expect(
    envelopes
      .filter((envelope) => envelope.aggregateId === firstAggregateId)
      .map((envelope) => envelope.eventId),
  ).toEqual([firstEvent.eventId, secondEvent.eventId]);
  expect(envelopes.some((envelope) => envelope.aggregateId === secondAggregateId)).toBe(true);
});
