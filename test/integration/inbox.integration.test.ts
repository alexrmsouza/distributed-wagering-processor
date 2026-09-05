import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import {
  createSqsClient,
  createSqsQueueConfiguration,
} from '../../src/messaging/infrastructure/sqs-client.factory.js';
import { WagerCommandConsumer } from '../../src/messaging/infrastructure/wager-command.consumer.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { Money } from '../../src/shared/domain/money.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { NOOP_WALLET_LOCK_METRICS } from '../../src/wallet/application/ports/wallet-lock-metrics.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { createWageringTransactionContext } from '../../src/wagering/infrastructure/persistence/wagering-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import { createTestEnvironment } from '../support/test-environment.js';

let databaseContext: DatabaseTestContext | undefined;
const testEnvironment = createTestEnvironment();
const sqsClient = createSqsClient(testEnvironment.configuration);

setDefaultTimeout(60_000);

function getDatabaseContext(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }

  return databaseContext;
}

async function captureError(operation: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await operation();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }

  throw new Error('Expected operation to fail');
}

function createEnvelope(input: {
  readonly messageId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly externalTransactionId?: string;
  readonly amount?: string;
}) {
  return {
    messageId: input.messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-09-04T12:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: input.externalTransactionId ?? randomUUID(),
      idempotencyKey: `provider-a:${input.messageId}`,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: 'round-inbox',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: input.amount ?? '25.00', currency: 'BRL' },
    },
  } as const;
}

async function persistedCounts(walletId: string): Promise<Record<string, string>> {
  const rows = await getDatabaseContext()
    .orm.em.getConnection()
    .execute<Record<string, string>[]>(
      `select
         (select count(*)::text from inbox_messages) as inbox_messages,
         (select count(*)::text from wager_transactions where wallet_id = ? and kind = 'BET') as transactions,
         (select count(*)::text from wallet_ledger_entries entry
           join wager_transactions transaction on transaction.id = entry.transaction_id
          where transaction.wallet_id = ? and transaction.kind = 'BET') as ledger_entries,
         (select count(*)::text from accounting_journals journal
           join wager_transactions transaction on transaction.id = journal.transaction_id
          where transaction.wallet_id = ? and transaction.kind = 'BET') as journals,
         (select count(*)::text from outbox_messages
           where payload -> 'data' ->> 'walletId' = ?
             and event_type in ('WagerTransactionProcessed', 'WalletBalanceChanged')) as outbox_messages`,
      [walletId, walletId, walletId, walletId],
    );

  const row = rows[0];
  if (row === undefined) {
    throw new Error('Persisted counts are unavailable');
  }
  return row;
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('command_inbox');
  await databaseContext.orm.migrator.up();
});

afterAll(async () => {
  sqsClient.destroy();
  await databaseContext?.close();
});

describe('Durable command Inbox', () => {
  test('returns the committed result for an exact duplicate without repeating any effect', async () => {
    const context = getDatabaseContext();
    const walletRunner = new MikroOrmTransactionRunner(context.orm, createWalletTransactionContext);
    const wallet = await new CreateWalletUseCase(walletRunner).execute({
      playerId: randomUUID(),
      initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
    });
    const wageringRunner = new MikroOrmTransactionRunner(context.orm, (entityManager) =>
      createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
    );
    const processWagerTransaction = new ProcessWagerTransactionUseCase(wageringRunner);
    const consumer = new WagerCommandConsumer({
      consumerName: 'wager-command-consumer',
      transactionRunner: wageringRunner,
      processWagerTransaction,
      sqsClient,
      queueConfiguration: createSqsQueueConfiguration(testEnvironment.configuration),
    });
    const envelope = createEnvelope({
      messageId: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
    });

    const first = await consumer.processEnvelope(JSON.stringify(envelope));
    const afterFirst = await persistedCounts(wallet.id);
    const duplicate = await consumer.processEnvelope(JSON.stringify(envelope));

    expect(first).toMatchObject({
      action: 'ACK',
      outcome: {
        status: 'PROCESSED',
        balance: Money.create({ amount: '75.00', currency: 'BRL' }),
        idempotentReplay: false,
      },
    });
    expect(duplicate).toMatchObject({
      action: 'ACK',
      outcome: {
        transactionId: first.outcome.transactionId,
        status: 'PROCESSED',
        balance: Money.create({ amount: '75.00', currency: 'BRL' }),
        idempotentReplay: true,
      },
    });
    expect(await persistedCounts(wallet.id)).toEqual(afterFirst);
    expect(afterFirst).toEqual({
      inbox_messages: '1',
      transactions: '1',
      ledger_entries: '1',
      journals: '1',
      outbox_messages: '2',
    });
  });

  test('preserves an unlinked WALLET_NOT_FOUND result identity across exact redelivery', async () => {
    const context = getDatabaseContext();
    const wageringRunner = new MikroOrmTransactionRunner(context.orm, (entityManager) =>
      createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
    );
    const consumer = new WagerCommandConsumer({
      consumerName: 'wager-command-consumer',
      transactionRunner: wageringRunner,
      processWagerTransaction: new ProcessWagerTransactionUseCase(wageringRunner),
      sqsClient,
      queueConfiguration: createSqsQueueConfiguration(testEnvironment.configuration),
    });
    const missingWalletId = randomUUID();
    const envelope = createEnvelope({
      messageId: randomUUID(),
      playerId: randomUUID(),
      walletId: missingWalletId,
    });

    const beforeFirst = await persistedCounts(missingWalletId);
    const first = await consumer.processEnvelope(JSON.stringify(envelope));
    const afterFirst = await persistedCounts(missingWalletId);
    const duplicate = await consumer.processEnvelope(JSON.stringify(envelope));

    expect(first).toMatchObject({
      action: 'ACK',
      outcome: {
        status: 'REJECTED',
        balance: Money.create({ amount: '0.00', currency: 'BRL' }),
        failureCode: 'WALLET_NOT_FOUND',
        idempotentReplay: false,
      },
    });
    expect(duplicate).toMatchObject({
      action: 'ACK',
      outcome: {
        transactionId: first.outcome.transactionId,
        status: 'REJECTED',
        balance: Money.create({ amount: '0.00', currency: 'BRL' }),
        failureCode: 'WALLET_NOT_FOUND',
        idempotentReplay: true,
      },
    });
    expect(await persistedCounts(missingWalletId)).toEqual(afterFirst);
    expect(afterFirst).toEqual({
      inbox_messages: String(Number(beforeFirst.inbox_messages) + 1),
      transactions: '0',
      ledger_entries: '0',
      journals: '0',
      outbox_messages: '0',
    });
  });

  test('rejects a divergent envelope with the same Inbox identity before business work', async () => {
    const context = getDatabaseContext();
    const walletRunner = new MikroOrmTransactionRunner(context.orm, createWalletTransactionContext);
    const wallet = await new CreateWalletUseCase(walletRunner).execute({
      playerId: randomUUID(),
      initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
    });
    const wageringRunner = new MikroOrmTransactionRunner(context.orm, (entityManager) =>
      createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
    );
    const consumer = new WagerCommandConsumer({
      consumerName: 'wager-command-consumer',
      transactionRunner: wageringRunner,
      processWagerTransaction: new ProcessWagerTransactionUseCase(wageringRunner),
      sqsClient,
      queueConfiguration: createSqsQueueConfiguration(testEnvironment.configuration),
    });
    const messageId = randomUUID();
    const envelope = createEnvelope({ messageId, playerId: wallet.playerId, walletId: wallet.id });
    await consumer.processEnvelope(JSON.stringify(envelope));
    const beforeConflict = await persistedCounts(wallet.id);

    const error = await captureError(() =>
      consumer.processEnvelope(
        JSON.stringify({
          ...envelope,
          data: { ...envelope.data, money: { amount: '30.00', currency: 'BRL' } },
        }),
      ),
    );

    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await persistedCounts(wallet.id)).toEqual(beforeConflict);
  });

  test('returns the original conflict classification for an exact duplicate delivery', async () => {
    const context = getDatabaseContext();
    const walletRunner = new MikroOrmTransactionRunner(context.orm, createWalletTransactionContext);
    const wallet = await new CreateWalletUseCase(walletRunner).execute({
      playerId: randomUUID(),
      initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
    });
    const wageringRunner = new MikroOrmTransactionRunner(context.orm, (entityManager) =>
      createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
    );
    const consumer = new WagerCommandConsumer({
      consumerName: 'wager-command-consumer',
      transactionRunner: wageringRunner,
      processWagerTransaction: new ProcessWagerTransactionUseCase(wageringRunner),
      sqsClient,
      queueConfiguration: createSqsQueueConfiguration(testEnvironment.configuration),
    });
    const original = createEnvelope({
      messageId: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
    });
    const processed = await consumer.processEnvelope(JSON.stringify(original));
    const conflictEnvelope = {
      ...createEnvelope({
        messageId: randomUUID(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        amount: '30.00',
      }),
      data: {
        ...original.data,
        money: { amount: '30.00', currency: 'BRL' },
      },
    };

    const firstConflict = await consumer.processEnvelope(JSON.stringify(conflictEnvelope));
    const beforeDuplicate = await persistedCounts(wallet.id);
    const duplicate = await consumer.processEnvelope(JSON.stringify(conflictEnvelope));

    expect(firstConflict).toEqual({
      action: 'ACK',
      outcome: {
        transactionId: processed.outcome.transactionId,
        status: 'CONFLICT',
        failureCode: 'IDEMPOTENCY_CONFLICT',
        idempotentReplay: false,
      },
    });
    expect(duplicate).toEqual(firstConflict);
    expect(await persistedCounts(wallet.id)).toEqual(beforeDuplicate);
  });
});
