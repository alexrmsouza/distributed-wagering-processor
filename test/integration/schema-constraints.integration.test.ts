import { randomUUID } from 'node:crypto';

import type { EntityManager } from '@mikro-orm/core';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';

let context: DatabaseTestContext;

async function executeInTransaction(
  entityManager: EntityManager,
  sql: string,
  parameters: readonly unknown[],
): Promise<void> {
  await entityManager
    .getConnection()
    .execute(sql, [...parameters], 'run', entityManager.getTransactionContext());
}

async function expectDatabaseRejection(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    return;
  }

  throw new Error('Expected PostgreSQL to reject the operation');
}

async function insertWallet(overrides: { balanceMinor?: bigint; playerId?: string } = {}) {
  const walletId = randomUUID();
  const playerId = overrides.playerId ?? randomUUID();
  const balanceMinor = overrides.balanceMinor ?? 0n;

  await context.orm.em.getConnection().execute(
    `insert into wallets
       (id, player_id, currency, balance_minor, version, ledger_sequence, created_at, updated_at)
     values (?, ?, 'BRL', ?, 1, 0, now(), now())`,
    [walletId, playerId, balanceMinor.toString()],
  );

  return { playerId, walletId };
}

async function insertCompleteWin(options: {
  readonly balanceBeforeMinor?: bigint;
  readonly creditAmountMinor?: bigint;
  readonly journalWalletId?: string;
}): Promise<{ readonly entryId: string; readonly journalId: string }> {
  const { walletId } = await insertWallet();
  const transactionId = randomUUID();
  const journalId = randomUUID();
  const entryId = randomUUID();
  const providerAccountId = randomUUID();
  const playerAccountId = randomUUID();
  const providerId = `provider-${randomUUID()}`;
  const balanceBeforeMinor = options.balanceBeforeMinor ?? 0n;
  const balanceAfterMinor = balanceBeforeMinor + 100n;

  await context.orm.em.transactional(async (entityManager) => {
    await executeInTransaction(
      entityManager,
      `insert into accounts (id, kind, owner_id, currency, created_at)
       values (?, 'PROVIDER_CLEARING', ?, 'BRL', now()),
              (?, 'PLAYER_BALANCE', ?, 'BRL', now())`,
      [providerAccountId, providerId, playerAccountId, walletId],
    );
    await executeInTransaction(
      entityManager,
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
          status, observed_balance_minor, created_at, updated_at)
       values (?, ?, ?, ?, repeat('f', 64), ?, ?,
               'round-complete', 'game-complete', 'WIN', 100, 'BRL',
               'PROCESSED', ?, now(), now())`,
      [
        transactionId,
        providerId,
        randomUUID(),
        randomUUID(),
        walletId,
        randomUUID(),
        balanceAfterMinor.toString(),
      ],
    );
    await executeInTransaction(
      entityManager,
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, entry_sequence, direction, amount_minor,
          currency, balance_before_minor, balance_after_minor, previous_entry_hash,
          entry_hash, created_at)
       values (?, ?, ?, 1, 'CREDIT', 100, 'BRL', ?, ?, null, repeat('f', 64), now())`,
      [
        entryId,
        walletId,
        transactionId,
        balanceBeforeMinor.toString(),
        balanceAfterMinor.toString(),
      ],
    );
    await executeInTransaction(
      entityManager,
      `update wallets
          set balance_minor = ?, ledger_sequence = 1,
              last_ledger_hash = repeat('f', 64), updated_at = now()
        where id = ?`,
      [balanceAfterMinor.toString(), walletId],
    );
    await executeInTransaction(
      entityManager,
      'insert into accounting_journals (id, transaction_id, wallet_id, created_at) values (?, ?, ?, now())',
      [journalId, transactionId, options.journalWalletId ?? walletId],
    );
    await executeInTransaction(
      entityManager,
      `insert into accounting_postings
         (id, journal_id, account_id, direction, amount_minor, currency, created_at)
       values (?, ?, ?, 'DEBIT', 100, 'BRL', now()),
              (?, ?, ?, 'CREDIT', ?, 'BRL', now())`,
      [
        randomUUID(),
        journalId,
        providerAccountId,
        randomUUID(),
        journalId,
        playerAccountId,
        (options.creditAmountMinor ?? 100n).toString(),
      ],
    );
  });

  return { entryId, journalId };
}

beforeAll(async () => {
  context = await createDatabaseTestContext('schema_test');
  await context.orm.migrator.up();

  return async () => {
    await context.close();
  };
});

describe('PostgreSQL financial invariants', () => {
  test('rejects a negative wallet balance and duplicate player currency', async () => {
    await expectDatabaseRejection(() => insertWallet({ balanceMinor: -1n }));

    const playerId = randomUUID();
    await insertWallet({ playerId });
    await expectDatabaseRejection(() => insertWallet({ playerId }));
  });

  test('rejects duplicate provider identities and malformed payload hashes', async () => {
    const { walletId } = await insertWallet();
    const transactionId = randomUUID();

    await context.orm.em.getConnection().execute(
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
          status, observed_balance_minor, created_at, updated_at)
       values (?, 'provider-a', 'external-a', 'key-a', repeat('a', 64), ?, ?,
               'round-a', 'game-a', 'LOSS', 100, 'BRL', 'PROCESSED', 0, now(), now())`,
      [transactionId, walletId, randomUUID()],
    );

    await expectDatabaseRejection(() =>
      context.orm.em.getConnection().execute(
        `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
            status, observed_balance_minor, created_at, updated_at)
         values (?, 'provider-a', 'external-b', 'key-a', repeat('b', 64), ?, ?,
                 'round-b', 'game-b', 'LOSS', 100, 'BRL', 'PROCESSED', 0, now(), now())`,
        [randomUUID(), walletId, randomUUID()],
      ),
    );

    await expectDatabaseRejection(() =>
      context.orm.em.getConnection().execute(
        `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
            status, observed_balance_minor, created_at, updated_at)
         values (?, 'provider-b', 'external-c', 'key-c', 'not-a-hash', ?, ?,
                 'round-c', 'game-c', 'LOSS', 100, 'BRL', 'PROCESSED', 0, now(), now())`,
        [randomUUID(), walletId, randomUUID()],
      ),
    );
  });

  test('enforces ledger arithmetic and immutability', async () => {
    const { walletId } = await insertWallet();
    const transactionId = randomUUID();

    await context.orm.em.getConnection().execute(
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
          status, observed_balance_minor, created_at, updated_at)
       values (?, 'provider-ledger', ?, ?, repeat('c', 64), ?, ?,
               'round-ledger', 'game-ledger', 'LOSS', 100, 'BRL', 'PROCESSED', 0, now(), now())`,
      [transactionId, randomUUID(), randomUUID(), walletId, randomUUID()],
    );

    await expectDatabaseRejection(() =>
      context.orm.em.getConnection().execute(
        `insert into wallet_ledger_entries
           (id, wallet_id, transaction_id, entry_sequence, direction, amount_minor,
            currency, balance_before_minor, balance_after_minor, previous_entry_hash,
            entry_hash, created_at)
         values (?, ?, ?, 1, 'DEBIT', 100, 'BRL', 0, 100, null, repeat('d', 64), now())`,
        [randomUUID(), walletId, transactionId],
      ),
    );

    const { entryId } = await insertCompleteWin({});

    await expectDatabaseRejection(() =>
      context.orm.em
        .getConnection()
        .execute('update wallet_ledger_entries set amount_minor = 200 where id = ?', [entryId]),
    );
    await expectDatabaseRejection(() =>
      context.orm.em
        .getConnection()
        .execute('delete from wallet_ledger_entries where id = ?', [entryId]),
    );
  });

  test('requires exactly two balanced immutable accounting postings at commit', async () => {
    await expectDatabaseRejection(() => insertCompleteWin({ creditAmountMinor: 99n }));

    const { journalId } = await insertCompleteWin({});

    await expectDatabaseRejection(() =>
      context.orm.em
        .getConnection()
        .execute('update accounting_postings set amount_minor = 200 where journal_id = ?', [
          journalId,
        ]),
    );
  });

  test('provides due-work indexes for pending references and Outbox leases', async () => {
    const indexes = await context.orm.em
      .getConnection()
      .execute<{ indexdef: string; indexname: string }[]>(
        `select indexdef, indexname
         from pg_indexes
        where schemaname = 'public'
          and indexname in (
            'wager_transactions_pending_reference_due_idx',
            'outbox_messages_publishable_idx',
            'wallet_ledger_entries_cursor_idx'
          )
        order by indexname`,
      );

    expect(indexes.map(({ indexname }) => indexname)).toEqual([
      'outbox_messages_publishable_idx',
      'wager_transactions_pending_reference_due_idx',
      'wallet_ledger_entries_cursor_idx',
    ]);
    expect(
      indexes.find(({ indexname }) => indexname === 'outbox_messages_publishable_idx')?.indexdef,
    ).toContain('lease_expires_at');
  });

  test('rejects a first ledger entry that hides a non-zero opening balance', async () => {
    await expectDatabaseRejection(() => insertCompleteWin({ balanceBeforeMinor: 50n }));
  });

  test('rejects a journal linked to a wallet other than its financial transaction', async () => {
    const { walletId: otherWalletId } = await insertWallet();

    await expectDatabaseRejection(() => insertCompleteWin({ journalWalletId: otherWalletId }));
  });

  test('keeps Inbox and Outbox identity immutable while allowing lifecycle updates', async () => {
    const inboxMessageId = randomUUID();
    const outboxId = randomUUID();

    await context.orm.em.getConnection().execute(
      `insert into inbox_messages
         (consumer_name, message_id, payload_hash, received_at)
       values ('consumer-a', ?, repeat('a', 64), now())`,
      [inboxMessageId],
    );
    await context.orm.em.getConnection().execute(
      `insert into outbox_messages
         (id, event_id, aggregate_id, event_type, version, payload, correlation_id,
          occurred_at, attempts, next_attempt_at)
       values (?, ?, ?, 'TestEvent', 1, '{}', ?, now(), 0, now())`,
      [outboxId, randomUUID(), randomUUID(), randomUUID()],
    );

    await expectDatabaseRejection(() =>
      context.orm.em
        .getConnection()
        .execute("update inbox_messages set payload_hash = repeat('b', 64) where message_id = ?", [
          inboxMessageId,
        ]),
    );
    await expectDatabaseRejection(() =>
      context.orm.em
        .getConnection()
        .execute("update outbox_messages set event_type = 'ChangedEvent' where id = ?", [outboxId]),
    );

    await context.orm.em
      .getConnection()
      .execute('update inbox_messages set processed_at = now() where message_id = ?', [
        inboxMessageId,
      ]);
    await context.orm.em.getConnection().execute(
      `update outbox_messages
          set attempts = 1, lease_token = ?, lease_expires_at = now() + interval '30 seconds'
        where id = ?`,
      [randomUUID(), outboxId],
    );
  });

  test('prevents terminal Wager Transactions from reopening', async () => {
    const { walletId } = await insertWallet();
    const transactionId = randomUUID();

    await context.orm.em.getConnection().execute(
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
          status, observed_balance_minor, created_at, updated_at)
       values (?, 'provider-terminal', ?, ?, repeat('a', 64), ?, ?,
               'round-terminal', 'game-terminal', 'LOSS', 100, 'BRL',
               'PROCESSED', 0, now(), now())`,
      [transactionId, randomUUID(), randomUUID(), walletId, randomUUID()],
    );

    await expectDatabaseRejection(() =>
      context.orm.em
        .getConnection()
        .execute(
          "update wager_transactions set status = 'PENDING', updated_at = now() where id = ?",
          [transactionId],
        ),
    );
  });

  test('keeps the original pending-reference request context immutable', async () => {
    const { playerId, walletId } = await insertWallet();
    const transactionId = randomUUID();

    await context.orm.em.getConnection().execute(
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
          reference_external_transaction_id, status, retry_attempts, next_retry_at,
          retry_expires_at, pending_correlation_id, pending_causation_id, created_at, updated_at)
       values (?, 'provider-pending', ?, ?, repeat('a', 64), ?, ?,
               'round-pending', 'game-pending', 'REFUND', 100, 'BRL', ?,
               'PENDING_REFERENCE', 0, now() + interval '30 seconds',
               now() + interval '24 hours', ?, ?, now(), now())`,
      [
        transactionId,
        randomUUID(),
        randomUUID(),
        walletId,
        playerId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );

    await expectDatabaseRejection(() =>
      context.orm.em
        .getConnection()
        .execute('update wager_transactions set pending_correlation_id = ? where id = ?', [
          randomUUID(),
          transactionId,
        ]),
    );
    await expectDatabaseRejection(() =>
      context.orm.em
        .getConnection()
        .execute('update wager_transactions set pending_causation_id = ? where id = ?', [
          randomUUID(),
          transactionId,
        ]),
    );
  });
});
