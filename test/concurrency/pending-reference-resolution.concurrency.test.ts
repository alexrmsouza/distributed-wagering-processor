import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import {
  asJsonRecord,
  postJson,
  requireTestService,
  startTestServices,
  stopTestServices,
  type TestServiceProcess,
} from '../support/service-process.js';

let databaseContext: DatabaseTestContext | undefined;
let services: readonly TestServiceProcess[] = [];

setDefaultTimeout(120_000);

function getDatabaseContext(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

function getService(index: number): TestServiceProcess {
  return requireTestService(services, index);
}

async function post(baseUrl: string, path: string, body: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (idempotencyKey !== undefined) {
    headers['idempotency-key'] = idempotencyKey;
  }
  return postJson(baseUrl, path, body, headers);
}

beforeAll(async () => {
  const context = await createDatabaseTestContext('pending_reference_resolution');
  databaseContext = context;
  await context.orm.migrator.up();
  services = await startTestServices(context.databaseName, 2);
});

afterAll(async () => {
  await stopTestServices(services);
  await databaseContext?.close();
});

describe('Concurrent pending-reference resolution across service processes', () => {
  test('resolves one pending reversal once and clears its recoverable lease', async () => {
    const playerId = randomUUID();
    const wallet = await post(getService(0).baseUrl, '/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(wallet.response.status).toBe(201);
    const walletId = String(wallet.body.id);
    const sourceExternalTransactionId = randomUUID();
    const reversalIdempotencyKey = randomUUID();
    const reversal = {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: 'round-pending-resolution',
      gameId: 'fortune-chimp',
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: sourceExternalTransactionId,
    };
    const pending = await post(
      getService(0).baseUrl,
      '/wagering/transactions',
      reversal,
      reversalIdempotencyKey,
    );
    expect(pending.response.status).toBe(202);
    expect(pending.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const pendingTransactionId = String(pending.body.transactionId);

    await getDatabaseContext()
      .orm.em.getConnection()
      .execute(
        `update wager_transactions
            set pending_lease_token = ?::uuid,
                pending_lease_expires_at = now() - interval '1 second'
          where id = ? and status = 'PENDING_REFERENCE'`,
        [randomUUID(), pendingTransactionId],
      );

    const source = await post(
      getService(1).baseUrl,
      '/wagering/transactions',
      {
        providerId: reversal.providerId,
        externalTransactionId: sourceExternalTransactionId,
        playerId,
        walletId,
        roundId: reversal.roundId,
        gameId: reversal.gameId,
        kind: 'BET',
        money: reversal.money,
      },
      randomUUID(),
    );
    expect(source.response.status).toBe(201);
    expect(source.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    const results = await Promise.all([
      post(getService(0).baseUrl, '/wagering/transactions', reversal, reversalIdempotencyKey),
      post(getService(1).baseUrl, '/wagering/transactions', reversal, reversalIdempotencyKey),
    ]);

    expect(results.every(({ response }) => response.status === 201)).toBeTrue();
    expect(results.filter(({ body }) => body.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter(({ body }) => body.idempotentReplay === true)).toHaveLength(1);
    expect(
      results.every(
        ({ body }) =>
          body.transactionId === pendingTransactionId &&
          body.status === 'PROCESSED' &&
          asJsonRecord(body.balance).amount === '100.00' &&
          asJsonRecord(body.balance).currency === 'BRL',
      ),
    ).toBeTrue();

    const financialRows = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<
        {
          balance_minor: string;
          journal_count: string;
          lease_expires_at: Date | null;
          lease_token: string | null;
          ledger_count: string;
          next_retry_at: Date | null;
          posting_count: string;
          reference_transaction_id: string;
          retry_expires_at: Date | null;
          status: string;
          transaction_count: string;
        }[]
      >(
        `select wallet.balance_minor::text,
                reversal.status,
                reversal.reference_transaction_id::text,
                reversal.pending_lease_token as lease_token,
                reversal.pending_lease_expires_at as lease_expires_at,
                reversal.next_retry_at,
                reversal.retry_expires_at,
                count(distinct reversal.id)::text as transaction_count,
                count(distinct entry.id)::text as ledger_count,
                count(distinct journal.id)::text as journal_count,
                count(distinct posting.id)::text as posting_count
           from wager_transactions reversal
           join wallets wallet on wallet.id = reversal.wallet_id
           left join wallet_ledger_entries entry on entry.transaction_id = reversal.id
           left join accounting_journals journal on journal.transaction_id = reversal.id
           left join accounting_postings posting on posting.journal_id = journal.id
          where reversal.id = ?
          group by wallet.balance_minor, reversal.status, reversal.reference_transaction_id,
                   reversal.pending_lease_token, reversal.pending_lease_expires_at,
                   reversal.next_retry_at, reversal.retry_expires_at`,
        [pendingTransactionId],
      );
    expect(financialRows).toEqual([
      {
        balance_minor: '10000',
        status: 'PROCESSED',
        reference_transaction_id: String(source.body.transactionId),
        lease_token: null,
        lease_expires_at: null,
        next_retry_at: null,
        retry_expires_at: null,
        transaction_count: '1',
        ledger_count: '1',
        journal_count: '1',
        posting_count: '2',
      },
    ]);

    const events = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ event_type: string; occurrences: string }[]>(
        `select event_type, count(*)::text as occurrences
           from outbox_messages
          where payload -> 'data' ->> 'transactionId' = ?
          group by event_type
          order by event_type`,
        [pendingTransactionId],
      );
    expect(events).toEqual([
      { event_type: 'WagerTransactionPendingReference', occurrences: '1' },
      { event_type: 'WagerTransactionProcessed', occurrences: '1' },
      { event_type: 'WalletBalanceChanged', occurrences: '1' },
    ]);
  });
});
