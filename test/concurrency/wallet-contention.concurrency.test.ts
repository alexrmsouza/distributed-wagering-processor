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

interface WagerRequest {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET';
  readonly money: { readonly amount: string; readonly currency: 'BRL' };
}

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

async function createWallet(baseUrl: string, amount = '100.00') {
  const playerId = randomUUID();
  const result = await postJson(baseUrl, '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(result.response.status).toBe(201);

  return { playerId, walletId: String(result.body.id) };
}

function createBet(
  walletId: string,
  playerId: string,
  amount: string,
  externalTransactionId = randomUUID(),
): WagerRequest {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-concurrency',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

async function postWager(baseUrl: string, request: WagerRequest, idempotencyKey: string) {
  return postJson(baseUrl, '/wagering/transactions', request, {
    'idempotency-key': idempotencyKey,
  });
}

beforeAll(async () => {
  const context = await createDatabaseTestContext('wallet_contention');
  databaseContext = context;
  await context.orm.migrator.up();
  services = await startTestServices(context.databaseName, 3);
});

afterAll(async () => {
  await stopTestServices(services);
  await databaseContext?.close();
});

describe('Wallet contention across service processes', () => {
  test('fifty concurrent identical deliveries create one financial effect', async () => {
    const wallet = await createWallet(getService(0).baseUrl);
    const request = createBet(wallet.walletId, wallet.playerId, '25.00');
    const idempotencyKey = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        postWager(getService(index % services.length).baseUrl, request, idempotencyKey),
      ),
    );

    expect(results.every(({ response }) => response.status === 201)).toBeTrue();
    expect(results.filter(({ body }) => body.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter(({ body }) => body.idempotentReplay === true)).toHaveLength(49);
    expect(new Set(results.map(({ body }) => body.transactionId)).size).toBe(1);
    expect(results.every(({ body }) => asJsonRecord(body.balance).amount === '75.00')).toBeTrue();

    const firstResult = results.at(0);
    if (firstResult === undefined) {
      throw new Error('No replay result was returned');
    }
    const transactionId = String(firstResult.body.transactionId);
    const rows = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<
        {
          balance_minor: string;
          journals: string;
          ledger_entries: string;
          outbox_messages: string;
          postings: string;
          transactions: string;
        }[]
      >(
        `select wallet.balance_minor::text,
         (select count(*)::text from wager_transactions
           where provider_id = ? and idempotency_key = ?) as transactions,
         (select count(*)::text from wallet_ledger_entries
           where transaction_id = ?) as ledger_entries,
         (select count(*)::text from accounting_journals
           where transaction_id = ?) as journals,
         (select count(*)::text from accounting_postings posting
           join accounting_journals journal on journal.id = posting.journal_id
          where journal.transaction_id = ?) as postings,
         (select count(*)::text from outbox_messages
           where payload -> 'data' ->> 'transactionId' = ?) as outbox_messages
       from wallets wallet
       where wallet.id = ?`,
        [
          request.providerId,
          idempotencyKey,
          transactionId,
          transactionId,
          transactionId,
          transactionId,
          wallet.walletId,
        ],
      );

    expect(rows[0]).toEqual({
      balance_minor: '7500',
      transactions: '1',
      ledger_entries: '1',
      journals: '1',
      postings: '2',
      outbox_messages: '2',
    });
  });

  test('two concurrent 80.00 bets against 100.00 serialize at wallet scope', async () => {
    const wallet = await createWallet(getService(0).baseUrl);
    const first = createBet(wallet.walletId, wallet.playerId, '80.00');
    const second = createBet(wallet.walletId, wallet.playerId, '80.00');

    const results = await Promise.all([
      postWager(getService(0).baseUrl, first, randomUUID()),
      postWager(getService(1).baseUrl, second, randomUUID()),
    ]);
    const processed = results.filter(({ body }) => body.status === 'PROCESSED');
    const rejected = results.filter(({ body }) => body.status === 'REJECTED');

    if (processed.length !== 1 || rejected.length !== 1) {
      throw new Error(
        `Unexpected contention outcomes: ${JSON.stringify(
          results.map(({ body, response }) => ({ body, status: response.status })),
        )}`,
      );
    }

    expect(processed).toHaveLength(1);
    const processedResult = processed.at(0);
    if (processedResult === undefined) {
      throw new Error('No processed result was returned');
    }
    expect(processedResult.response.status).toBe(201);
    expect(processedResult.body).toMatchObject({
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(rejected).toHaveLength(1);
    const rejectedResult = rejected.at(0);
    if (rejectedResult === undefined) {
      throw new Error('No rejected result was returned');
    }
    expect(rejectedResult.response.status).toBe(422);
    expect(rejectedResult.body).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const rows = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<
        {
          balance_minor: string;
          journals: string;
          ledger_entries: string;
          processed: string;
          rejected: string;
        }[]
      >(
        `select wallet.balance_minor::text,
         count(*) filter (where transaction.status = 'PROCESSED')::text as processed,
         count(*) filter (where transaction.status = 'REJECTED'
           and transaction.failure_code = 'INSUFFICIENT_FUNDS')::text as rejected,
         count(entry.id)::text as ledger_entries,
         count(journal.id)::text as journals
       from wallets wallet
       join wager_transactions transaction on transaction.wallet_id = wallet.id
        and transaction.kind = 'BET'
       left join wallet_ledger_entries entry on entry.transaction_id = transaction.id
       left join accounting_journals journal on journal.transaction_id = transaction.id
       where wallet.id = ?
       group by wallet.balance_minor`,
        [wallet.walletId],
      );

    expect(rows[0]).toEqual({
      balance_minor: '2000',
      processed: '1',
      rejected: '1',
      ledger_entries: '1',
      journals: '1',
    });
  });
});
