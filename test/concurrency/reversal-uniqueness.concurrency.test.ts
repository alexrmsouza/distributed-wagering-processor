import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import {
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

async function expectDatabaseRejection(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    return;
  }
  throw new Error('Expected PostgreSQL to reject the duplicate reversal');
}

beforeAll(async () => {
  const context = await createDatabaseTestContext('reversal_uniqueness');
  databaseContext = context;
  await context.orm.migrator.up();
  services = await startTestServices(context.databaseName, 2);
});

afterAll(async () => {
  await stopTestServices(services);
  await databaseContext?.close();
});

describe('Concurrent reversal uniqueness across service processes', () => {
  test('allows exactly one REFUND for one BET reference with distinct delivery identities', async () => {
    const playerId = randomUUID();
    const wallet = await post(getService(0).baseUrl, '/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(wallet.response.status).toBe(201);
    const walletId = String(wallet.body.id);
    const sourceExternalTransactionId = randomUUID();
    const source = await post(
      getService(0).baseUrl,
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: sourceExternalTransactionId,
        playerId,
        walletId,
        roundId: 'round-concurrent-reversal',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
      randomUUID(),
    );
    expect(source.response.status).toBe(201);
    expect(source.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    const reversalBase = {
      providerId: 'provider-a',
      playerId,
      walletId,
      roundId: 'round-concurrent-reversal',
      gameId: 'fortune-chimp',
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: sourceExternalTransactionId,
    };
    const results = await Promise.all([
      post(
        getService(0).baseUrl,
        '/wagering/transactions',
        { ...reversalBase, externalTransactionId: randomUUID() },
        randomUUID(),
      ),
      post(
        getService(1).baseUrl,
        '/wagering/transactions',
        { ...reversalBase, externalTransactionId: randomUUID() },
        randomUUID(),
      ),
    ]);
    const processed = results.filter(({ body }) => body.status === 'PROCESSED');
    const rejected = results.filter(({ body }) => body.status === 'REJECTED');

    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const processedResult = processed.at(0);
    const rejectedResult = rejected.at(0);
    if (processedResult === undefined || rejectedResult === undefined) {
      throw new Error('Expected one processed and one rejected concurrent reversal');
    }
    expect(processedResult.response.status).toBe(201);
    expect(processedResult.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(rejectedResult.response.status).toBe(422);
    expect(rejectedResult.body).toMatchObject({
      failureCode: 'REFERENCE_ALREADY_REVERSED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const rows = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<
        {
          balance_minor: string;
          journal_count: string;
          ledger_count: string;
          processed: string;
          rejected: string;
          resolved_references: string;
        }[]
      >(
        `select wallet.balance_minor::text,
           count(*) filter (where reversal.status = 'PROCESSED')::text as processed,
           count(*) filter (where reversal.status = 'REJECTED'
             and reversal.failure_code = 'REFERENCE_ALREADY_REVERSED')::text as rejected,
           count(*) filter (where reversal.reference_transaction_id = ?)::text as resolved_references,
           count(distinct entry.id)::text as ledger_count,
           count(distinct journal.id)::text as journal_count
         from wallets wallet
         join wager_transactions reversal on reversal.wallet_id = wallet.id
          and reversal.kind = 'REFUND'
         left join wallet_ledger_entries entry on entry.transaction_id = reversal.id
         left join accounting_journals journal on journal.transaction_id = reversal.id
        where wallet.id = ?
        group by wallet.balance_minor`,
        [String(source.body.transactionId), walletId],
      );
    expect(rows[0]).toEqual({
      balance_minor: '10000',
      processed: '1',
      rejected: '1',
      resolved_references: '1',
      ledger_count: '1',
      journal_count: '1',
    });

    const indexes = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ indexdef: string }[]>(
        `select indexdef from pg_indexes
          where schemaname = current_schema()
            and indexname = 'wager_transactions_reversal_unique_idx'`,
      );
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef.toLowerCase()).toContain(
      'unique index wager_transactions_reversal_unique_idx',
    );

    const processedReversalId = String(processedResult.body.transactionId);
    await expectDatabaseRejection(() =>
      getDatabaseContext()
        .orm.em.getConnection()
        .execute(
          `insert into wager_transactions
             (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
              reference_external_transaction_id, reference_transaction_id, status,
              failure_code, observed_balance_minor, observed_balance_currency, retry_attempts,
              next_retry_at, retry_expires_at, processed_at, created_at, updated_at)
           select ?, provider_id, ?, ?, repeat('a', 64), wallet_id, player_id, round_id,
                  game_id, kind, amount_minor, currency, reference_external_transaction_id,
                  reference_transaction_id, 'PENDING', null, null, null, 0, null, null, null,
                  now(), now()
             from wager_transactions
            where id = ?`,
          [randomUUID(), randomUUID(), randomUUID(), processedReversalId],
        ),
    );
  });
});
