import { randomUUID } from 'node:crypto';

import type { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { OutboxWorker } from '../../src/messaging/infrastructure/outbox.worker.js';
import type { IntegrationEventPublisher } from '../../src/messaging/infrastructure/integration-event.publisher.js';
import { MikroOrmOutboxRepository } from '../../src/messaging/infrastructure/outbox.repository.js';
import { WagerCommandConsumer } from '../../src/messaging/infrastructure/wager-command.consumer.js';
import { RedactingJsonLogger } from '../../src/observability/infrastructure/redacting-json.logger.js';
import type { Clock } from '../../src/shared/application/clock.js';
import {
  createCorrelationContext,
  type CorrelationContext,
} from '../../src/shared/application/correlation-context.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { Money } from '../../src/shared/domain/money.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { createWageringTransactionContext } from '../../src/wagering/infrastructure/persistence/wagering-transaction-context.js';
import { NOOP_WALLET_LOCK_METRICS } from '../../src/wallet/application/ports/wallet-lock-metrics.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';

const COMMAND_TIMELINE = Object.freeze([
  'received',
  'idempotency_decision',
  'wallet_lock',
  'outbox_persisted',
  'transaction_committed',
  'acknowledged',
] as const);
const OUTBOX_TIMELINE = Object.freeze(['outbox_claimed', 'published'] as const);
const REDACTION_MARKER = '[REDACTED]';

interface DiagnosticRecord {
  readonly level: string | number;
  readonly event: string;
  readonly correlationId: string;
  readonly messageId?: string;
  readonly transactionId?: string;
  readonly walletId?: string;
  readonly providerId?: string;
  readonly outboxMessageId?: string;
  readonly [key: string]: unknown;
}

class FixedClock implements Clock {
  public constructor(private readonly instant: Date) {}

  public now(): Date {
    return new Date(this.instant);
  }
}

let databaseContext: DatabaseTestContext | undefined;

setDefaultTimeout(60_000);

function database(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

function parseRecords(lines: readonly string[]): readonly DiagnosticRecord[] {
  return lines.map((line) => JSON.parse(line) as DiagnosticRecord);
}

function createLogger(lines: string[]): RedactingJsonLogger {
  return new RedactingJsonLogger({
    write: (line: string) => lines.push(line),
    clock: new FixedClock(new Date('2026-09-04T16:00:00.000Z')),
  });
}

function createSqsClient(): SQSClient {
  return {
    send: () => Promise.resolve({}),
    destroy: () => undefined,
  } as unknown as SQSClient;
}

async function createFundedWallet(): Promise<{
  readonly id: string;
  readonly playerId: string;
}> {
  const runner = new MikroOrmTransactionRunner(database().orm, createWalletTransactionContext);
  const wallet = await new CreateWalletUseCase(runner, {
    clock: new FixedClock(new Date('2026-09-04T15:00:00.000Z')),
  }).execute({
    playerId: randomUUID(),
    initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
  });

  await database()
    .orm.em.getConnection()
    .execute(
      `update outbox_messages
        set published_at = now()
      where aggregate_id = ? and event_type = 'WalletOpened'`,
      [wallet.id],
    );

  return Object.freeze({ id: wallet.id, playerId: wallet.playerId });
}

function wagerEnvelope(options: {
  readonly messageId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind?: 'BET' | 'LOSS';
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    messageId: options.messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-09-04T15:30:00.000Z',
    data: Object.freeze({
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId: options.playerId,
      walletId: options.walletId,
      roundId: 'round-observability',
      gameId: 'fortune-chimp',
      kind: options.kind ?? 'BET',
      money: Object.freeze({ amount: '25.00', currency: 'BRL' }),
    }),
  });
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('structured_logging');
  await databaseContext.orm.migrator.up();
});

afterAll(async () => {
  await databaseContext?.close();
});

describe('Redacting JSON diagnostics', () => {
  test('emits fixed structured event names and recursively redacts sensitive values', () => {
    const lines: string[] = [];
    const logger = createLogger(lines);
    const context = createCorrelationContext({
      correlationId: 'correlation-safe',
      messageId: 'message-safe',
      walletId: 'wallet-safe',
      providerId: 'provider-safe',
    });
    const sensitiveValues = [
      '987654.32',
      'raw-financial-payload',
      'Bearer production-token',
      'session=production-cookie',
      'receipt-handle-secret',
      'postgresql://admin:password@database:5432/wagering',
      'database-password',
      'aws-secret-access-key',
      'nested-client-secret',
      'cmV2ZXJzaWJsZS1zZWNyZXQ=',
    ] as const;

    logger.info('reconciliation_diverged', context, {
      outcome: 'diverged',
      checkedEntries: 42,
      money: { amount: sensitiveValues[0], currency: 'BRL' },
      payload: { raw: sensitiveValues[1] },
      headers: {
        authorization: sensitiveValues[2],
        cookie: sensitiveValues[3],
      },
      receiptHandle: sensitiveValues[4],
      connectionString: sensitiveValues[5],
      password: sensitiveValues[6],
      awsSecretAccessKey: sensitiveValues[7],
      nested: {
        clientSecret: sensitiveValues[8],
        credentials: [{ backup: sensitiveValues[9] }],
      },
      error: new Error(`database rejected ${sensitiveValues[5]}`),
    });

    expect(lines).toHaveLength(1);
    const serialized = lines[0] ?? '';
    const record = parseRecords(lines)[0];
    expect(record).toMatchObject({
      event: 'reconciliation_diverged',
      correlationId: 'correlation-safe',
      messageId: 'message-safe',
      walletId: 'wallet-safe',
      providerId: 'provider-safe',
      outcome: 'diverged',
      checkedEntries: 42,
      money: REDACTION_MARKER,
      payload: REDACTION_MARKER,
      headers: REDACTION_MARKER,
      receiptHandle: REDACTION_MARKER,
      connectionString: REDACTION_MARKER,
      password: REDACTION_MARKER,
      awsSecretAccessKey: REDACTION_MARKER,
      nested: {
        clientSecret: REDACTION_MARKER,
        credentials: REDACTION_MARKER,
      },
      error: REDACTION_MARKER,
    });
    expect(record).toHaveProperty('level');
    expect(serialized).toContain(REDACTION_MARKER);
    for (const sensitiveValue of sensitiveValues) {
      expect(serialized).not.toContain(sensitiveValue);
    }
  });

  test('rejects user-controlled event names and omits identifiers that are not known', () => {
    const lines: string[] = [];
    const logger = createLogger(lines);
    const context = createCorrelationContext({ correlationId: 'correlation-only' });

    expect(() => {
      (logger.info as (event: string, context: CorrelationContext) => void)(
        'user-controlled-event-name',
        context,
      );
    }).toThrow('Unsupported diagnostic event name');

    logger.info('received', context);
    expect(parseRecords(lines)[0]).toMatchObject({
      event: 'received',
      correlationId: 'correlation-only',
    });
    expect(parseRecords(lines)[0]).not.toHaveProperty('messageId');
    expect(parseRecords(lines)[0]).not.toHaveProperty('transactionId');
    expect(parseRecords(lines)[0]).not.toHaveProperty('walletId');
    expect(parseRecords(lines)[0]).not.toHaveProperty('providerId');
    expect(parseRecords(lines)[0]).not.toHaveProperty('outboxMessageId');
  });

  test('redacts sensitive context values and prevents reserved-field injection', () => {
    const lines: string[] = [];
    const logger = createLogger(lines);

    logger.info(
      'received',
      createCorrelationContext({
        correlationId: 'correlation-authoritative',
        providerId: 'Bearer provider-token',
      }),
      {
        event: 'injected-event',
        correlationId: 'injected-correlation',
        transactionId: 'injected-transaction',
        level: 'debug',
        time: '1900-01-01T00:00:00.000Z',
      },
    );

    expect(parseRecords(lines)[0]).toEqual({
      level: 'info',
      time: '2026-09-04T16:00:00.000Z',
      event: 'received',
      correlationId: 'correlation-authoritative',
      providerId: REDACTION_MARKER,
    });
    expect(lines[0]).not.toContain('provider-token');
    expect(lines[0]).not.toContain('injected-');
  });
});

describe('Correlated diagnostic timelines', () => {
  test('correlates the executable command and Outbox lifecycles without leaking transport or money data', async () => {
    const lines: string[] = [];
    const logger = createLogger(lines);
    const wallet = await createFundedWallet();
    const messageId = randomUUID();
    const receiptHandle = 'sensitive-command-receipt-handle';
    const rawEnvelope = JSON.stringify(
      wagerEnvelope({ messageId, walletId: wallet.id, playerId: wallet.playerId }),
    );
    const wageringRunner = new MikroOrmTransactionRunner(database().orm, (entityManager) =>
      createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
    );
    const processWagerTransaction = new ProcessWagerTransactionUseCase(wageringRunner, {
      clock: new FixedClock(new Date('2026-09-04T15:30:00.000Z')),
      logger,
    });
    const sqsClient = createSqsClient();
    const consumer = new WagerCommandConsumer({
      consumerName: 'structured-logging-test-consumer',
      transactionRunner: wageringRunner,
      processWagerTransaction,
      sqsClient,
      queueConfiguration: {
        commandQueueUrl: 'http://localhost/wager-transactions.fifo',
        commandDeadLetterQueueUrl: 'http://localhost/wager-transactions-dlq.fifo',
        eventQueueUrl: 'http://localhost/wager-integration-events.fifo',
      },
      clock: new FixedClock(new Date('2026-09-04T15:30:00.000Z')),
      logger,
      enabled: false,
    });

    const result = await consumer.processMessage({
      MessageId: messageId,
      ReceiptHandle: receiptHandle,
      Body: rawEnvelope,
      Attributes: { ApproximateReceiveCount: '1' },
    });
    expect(result.action).toBe('ACK');

    const publishedOutboxIds: string[] = [];
    const publisher: IntegrationEventPublisher = {
      publish: (message) => {
        publishedOutboxIds.push(message.id);
        return Promise.resolve();
      },
    };
    const outboxRunner = new MikroOrmTransactionRunner(database().orm, (entityManager) => ({
      outbox: new MikroOrmOutboxRepository(entityManager),
    }));
    const outboxWorker = new OutboxWorker(outboxRunner, publisher, {
      clock: new FixedClock(new Date('2026-09-04T15:31:00.000Z')),
      generateLeaseToken: randomUUID,
      logger,
    });
    await outboxWorker.runOnce();
    await outboxWorker.runOnce();

    const records = parseRecords(lines).filter(({ correlationId }) => correlationId === messageId);
    const commandEvents = records
      .map(({ event }) => event)
      .filter((event): event is (typeof COMMAND_TIMELINE)[number] =>
        COMMAND_TIMELINE.includes(event as (typeof COMMAND_TIMELINE)[number]),
      );
    const outboxEvents = records
      .map(({ event }) => event)
      .filter((event): event is (typeof OUTBOX_TIMELINE)[number] =>
        OUTBOX_TIMELINE.includes(event as (typeof OUTBOX_TIMELINE)[number]),
      );

    expect(commandEvents).toEqual([...COMMAND_TIMELINE]);
    expect(outboxEvents).toEqual(['outbox_claimed', 'published', 'outbox_claimed', 'published']);
    expect(publishedOutboxIds).toHaveLength(2);
    const outboxRecords = records.filter(
      ({ event }) => event === 'outbox_claimed' || event === 'published',
    );
    expect(
      outboxRecords.every(
        (record) =>
          record.outboxMessageId !== undefined &&
          record.walletId === wallet.id &&
          (record.providerId === undefined || record.providerId === 'provider-a'),
      ),
    ).toBe(true);
    expect(outboxRecords.some(({ providerId }) => providerId === 'provider-a')).toBe(true);

    const received = records.find(({ event }) => event === 'received');
    expect(received).toMatchObject({
      correlationId: messageId,
      messageId,
      walletId: wallet.id,
      providerId: 'provider-a',
    });
    expect(received).not.toHaveProperty('transactionId');
    expect(received).not.toHaveProperty('outboxMessageId');

    const committed = records.find(({ event }) => event === 'transaction_committed');
    expect(committed?.transactionId).toBe(result.outcome?.transactionId ?? undefined);

    const serialized = lines.join('\n');
    expect(serialized).not.toContain('25.00');
    expect(serialized).not.toContain(rawEnvelope);
    expect(serialized).not.toContain(receiptHandle);
  });

  test('does not fabricate a wallet-lock stage for a non-mutating LOSS', async () => {
    const lines: string[] = [];
    const logger = createLogger(lines);
    const wallet = await createFundedWallet();
    const messageId = randomUUID();
    const wageringRunner = new MikroOrmTransactionRunner(database().orm, (entityManager) =>
      createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
    );
    const processWagerTransaction = new ProcessWagerTransactionUseCase(wageringRunner, {
      clock: new FixedClock(new Date('2026-09-04T15:45:00.000Z')),
      logger,
    });
    const consumer = new WagerCommandConsumer({
      consumerName: 'structured-logging-loss-test-consumer',
      transactionRunner: wageringRunner,
      processWagerTransaction,
      sqsClient: createSqsClient(),
      queueConfiguration: {
        commandQueueUrl: 'http://localhost/wager-transactions.fifo',
        commandDeadLetterQueueUrl: 'http://localhost/wager-transactions-dlq.fifo',
        eventQueueUrl: 'http://localhost/wager-integration-events.fifo',
      },
      clock: new FixedClock(new Date('2026-09-04T15:45:00.000Z')),
      logger,
      enabled: false,
    });

    const result = await consumer.processMessage({
      MessageId: messageId,
      ReceiptHandle: 'loss-receipt-secret',
      Body: JSON.stringify(
        wagerEnvelope({
          messageId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: 'LOSS',
        }),
      ),
      Attributes: { ApproximateReceiveCount: '1' },
    });

    expect(result.action).toBe('ACK');
    const events = parseRecords(lines)
      .filter(({ correlationId }) => correlationId === messageId)
      .map(({ event }) => event);
    expect(events).toEqual([
      'received',
      'idempotency_decision',
      'outbox_persisted',
      'transaction_committed',
      'acknowledged',
    ]);
    expect(events).not.toContain('wallet_lock');
  });
});
