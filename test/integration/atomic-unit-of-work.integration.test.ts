import { randomUUID } from 'node:crypto';

import { RequestContext, type EntityManager } from '@mikro-orm/core';
import { expect, test } from 'bun:test';

import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { FailpointController } from '../../src/shared/infrastructure/failpoints/failpoint-controller.js';
import { createDatabaseTestContext } from '../support/database-test-context.js';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'accounts',
  'accounting_journals',
  'accounting_postings',
  'inbox_messages',
  'outbox_messages',
] as const;

async function executeInTransaction(
  entityManager: EntityManager,
  sql: string,
  parameters: readonly unknown[],
): Promise<void> {
  await entityManager
    .getConnection()
    .execute(sql, [...parameters], 'run', entityManager.getTransactionContext());
}

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }

  throw new Error('Expected operation to fail');
}

test('rolls back every financial and messaging write when a failpoint fires', async () => {
  const context = await createDatabaseTestContext('atomic_test');

  try {
    await context.orm.migrator.up();

    const runner = new MikroOrmTransactionRunner(context.orm, (entityManager) => entityManager);
    const failpoints = FailpointController.create({ enabled: true, environment: 'test' });
    let requestContextObserved = false;
    let transactionContextObserved = false;
    failpoints.arm('before_financial_commit');

    const rollbackError = await captureError(() =>
      runner.run(async (entityManager) => {
        requestContextObserved = RequestContext.currentRequestContext() !== undefined;
        transactionContextObserved = entityManager.getTransactionContext() !== undefined;

        const walletId = randomUUID();
        const transactionId = randomUUID();
        const journalId = randomUUID();
        const fundingAccountId = randomUUID();
        const playerAccountId = randomUUID();

        await executeInTransaction(
          entityManager,
          `insert into wallets
             (id, player_id, currency, balance_minor, version, ledger_sequence,
              last_ledger_hash, created_at, updated_at)
           values (?, ?, 'BRL', 100, 1, 1, repeat('1', 64), now(), now())`,
          [walletId, randomUUID()],
        );
        await executeInTransaction(
          entityManager,
          `insert into wager_transactions
             (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
              status, observed_balance_minor, created_at, updated_at)
           values (?, 'internal', ?, ?, repeat('2', 64), ?, ?, 'opening', 'internal',
                   'OPENING', 100, 'BRL', 'PROCESSED', 100, now(), now())`,
          [transactionId, randomUUID(), randomUUID(), walletId, randomUUID()],
        );
        await executeInTransaction(
          entityManager,
          `insert into wallet_ledger_entries
             (id, wallet_id, transaction_id, entry_sequence, direction, amount_minor,
              currency, balance_before_minor, balance_after_minor, previous_entry_hash,
              entry_hash, created_at)
           values (?, ?, ?, 1, 'CREDIT', 100, 'BRL', 0, 100, null, repeat('1', 64), now())`,
          [randomUUID(), walletId, transactionId],
        );
        await executeInTransaction(
          entityManager,
          `insert into accounts (id, kind, owner_id, currency, created_at)
           values (?, 'INTERNAL_FUNDING', 'internal', 'BRL', now()),
                  (?, 'PLAYER_BALANCE', ?, 'BRL', now())`,
          [fundingAccountId, playerAccountId, walletId],
        );
        await executeInTransaction(
          entityManager,
          'insert into accounting_journals (id, transaction_id, wallet_id, created_at) values (?, ?, ?, now())',
          [journalId, transactionId, walletId],
        );
        await executeInTransaction(
          entityManager,
          `insert into accounting_postings
             (id, journal_id, account_id, direction, amount_minor, currency, created_at)
           values (?, ?, ?, 'DEBIT', 100, 'BRL', now()),
                  (?, ?, ?, 'CREDIT', 100, 'BRL', now())`,
          [randomUUID(), journalId, fundingAccountId, randomUUID(), journalId, playerAccountId],
        );
        await executeInTransaction(
          entityManager,
          `insert into inbox_messages
             (consumer_name, message_id, payload_hash, transaction_id, received_at, processed_at)
           values ('wager-consumer', ?, repeat('3', 64), ?, now(), now())`,
          [randomUUID(), transactionId],
        );
        await executeInTransaction(
          entityManager,
          `insert into outbox_messages
             (id, event_id, aggregate_id, event_type, version, payload, correlation_id,
              occurred_at, attempts, next_attempt_at)
           values (?, ?, ?, 'WalletOpened', 1, '{}', ?, now(), 0, now())`,
          [randomUUID(), randomUUID(), walletId, randomUUID()],
        );

        await failpoints.trigger('before_financial_commit');
      }),
    );
    expect(rollbackError.message).toContain('Failpoint triggered: before_financial_commit');
    expect(requestContextObserved).toBe(true);
    expect(transactionContextObserved).toBe(true);

    for (const table of TABLES) {
      const rows = await context.orm.em
        .getConnection()
        .execute<{ count: string }[]>(`select count(*)::text as count from ${table}`);
      expect(rows[0]?.count).toBe('0');
    }

    await failpoints.trigger('before_financial_commit');
  } finally {
    await context.close();
  }
});

test('keeps failpoint controls unavailable outside dedicated test configuration', () => {
  expect(() => FailpointController.create({ enabled: true, environment: 'production' })).toThrow(
    'Failpoints are only available in test environments',
  );
  expect(() => FailpointController.create({ enabled: false, environment: 'test' })).toThrow(
    'Failpoints are disabled',
  );
});
