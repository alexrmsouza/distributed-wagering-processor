import { randomUUID } from 'node:crypto';

import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { Money } from '../../src/shared/domain/money.js';
import { FailpointController } from '../../src/shared/infrastructure/failpoints/failpoint-controller.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import { createTestEnvironment } from '../support/test-environment.js';

let application: INestApplication | undefined;
let baseUrl: string;
let databaseContext: DatabaseTestContext | undefined;

setDefaultTimeout(30_000);

function getDatabaseContext(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
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

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }

  throw new Error('Expected operation to fail');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }

  return value as Record<string, unknown>;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return asRecord((await response.json()) as unknown);
}

async function postWallet(playerId: string, amount = '1000.00', currency = 'BRL') {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount, currency },
    }),
  });

  return { body: await readJson(response), response };
}

beforeAll(async () => {
  const { WalletModule } = await import('../../src/wallet/wallet.module.js');

  databaseContext = await createDatabaseTestContext('wallet_http');
  await databaseContext.orm.migrator.up();

  const environment = createTestEnvironment({ DATABASE_NAME: databaseContext.databaseName });
  const { createMikroOrmConfig } =
    await import('../../src/bootstrap/configuration/mikro-orm.config.js');

  @Module({
    imports: [
      MikroOrmModule.forRoot(createMikroOrmConfig(environment.configuration)),
      WalletModule,
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest uses this class as a module metadata root.
  class WalletHttpTestModule {}

  application = await NestFactory.create(WalletHttpTestModule, { logger: false });
  await application.listen(0, '127.0.0.1');
  baseUrl = await application.getUrl();
});

afterAll(async () => {
  await application?.close();
  await databaseContext?.close();
});

describe('Wallet HTTP contract', () => {
  test('POST /wallets returns 201 with exact public Money and version one', async () => {
    const playerId = randomUUID();
    const { body, response } = await postWallet(playerId);

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(body.id).toBeString();
  });

  test('POST /wallets returns 409 for a duplicate player and currency', async () => {
    const playerId = randomUUID();
    expect((await postWallet(playerId)).response.status).toBe(201);

    const duplicate = await postWallet(playerId);

    expect(duplicate.response.status).toBe(409);
  });

  test('serializes concurrent duplicate creation into one financial graph', async () => {
    const playerId = randomUUID();
    const attempts = await Promise.all([
      postWallet(playerId, '80.00'),
      postWallet(playerId, '80.00'),
    ]);
    const statuses = attempts.map(({ response }) => response.status).sort();
    const rows = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<
        {
          journals: string;
          ledger_entries: string;
          openings: string;
          outbox_messages: string;
          wallets: string;
        }[]
      >(
        `select
         (select count(*)::text from wallets
           where player_id = ? and currency = 'BRL') as wallets,
         (select count(*)::text from wager_transactions transaction
           join wallets wallet on wallet.id = transaction.wallet_id
          where wallet.player_id = ? and transaction.kind = 'OPENING') as openings,
         (select count(*)::text from wallet_ledger_entries entry
           join wallets wallet on wallet.id = entry.wallet_id
          where wallet.player_id = ?) as ledger_entries,
         (select count(*)::text from accounting_journals journal
           join wallets wallet on wallet.id = journal.wallet_id
          where wallet.player_id = ?) as journals,
         (select count(*)::text from outbox_messages message
           join wallets wallet on wallet.id = message.aggregate_id
          where wallet.player_id = ?) as outbox_messages`,
        [playerId, playerId, playerId, playerId, playerId],
      );

    expect(statuses).toEqual([201, 409]);
    expect(rows[0]).toEqual({
      wallets: '1',
      openings: '1',
      ledger_entries: '1',
      journals: '1',
      outbox_messages: '1',
    });
  });

  test('POST /wallets rejects malformed Money without coercion', async () => {
    const invalidScale = await postWallet(randomUUID(), '10.0');
    const lowercaseCurrency = await postWallet(randomUUID(), '10.00', 'brl');

    expect(invalidScale.response.status).toBe(400);
    expect(invalidScale.body).toMatchObject({ failureCode: 'INVALID_PAYLOAD' });
    expect(lowercaseCurrency.response.status).toBe(400);
    expect(lowercaseCurrency.body).toMatchObject({ failureCode: 'INVALID_PAYLOAD' });
  });

  test('GET /wallets/:walletId returns the persisted exact wallet', async () => {
    const playerId = randomUUID();
    const created = await postWallet(playerId, '125.50', 'USD');
    expect(created.response.status).toBe(201);
    expect(created.body.id).toBeString();

    const response = await fetch(`${baseUrl}/wallets/${String(created.body.id)}`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      id: created.body.id,
      playerId,
      balance: { amount: '125.50', currency: 'USD' },
      version: 1,
    });
  });

  test('GET /wallets/:walletId/ledger returns the immutable opening movement', async () => {
    const created = await postWallet(randomUUID(), '75.00');
    expect(created.body.id).toBeString();

    const response = await fetch(`${baseUrl}/wallets/${String(created.body.id)}/ledger?limit=50`);
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      items: [
        {
          direction: 'CREDIT',
          amount: { amount: '75.00', currency: 'BRL' },
          balanceBefore: { amount: '0.00', currency: 'BRL' },
          balanceAfter: { amount: '75.00', currency: 'BRL' },
          entrySequence: 1,
        },
      ],
      nextCursor: null,
    });
  });

  test('GET /wallets/:walletId returns 404 with WALLET_NOT_FOUND', async () => {
    const response = await fetch(`${baseUrl}/wallets/${randomUUID()}`);

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ failureCode: 'WALLET_NOT_FOUND' });
  });

  test('persists the funded opening and versioned Outbox envelope atomically', async () => {
    const created = await postWallet(randomUUID(), '321.09');
    const walletId = String(created.body.id);
    const rows = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<
        {
          event_type: string;
          journal_count: string;
          ledger_count: string;
          opening_count: string;
          payload: Record<string, unknown>;
          player_account_count: string;
          posting_count: string;
        }[]
      >(
        `select
         (select count(*)::text from wager_transactions
           where wallet_id = ? and kind = 'OPENING') as opening_count,
         (select count(*)::text from wallet_ledger_entries where wallet_id = ?) as ledger_count,
         (select count(*)::text from accounting_journals where wallet_id = ?) as journal_count,
         (select count(*)::text from accounting_postings posting
           join accounting_journals journal on journal.id = posting.journal_id
          where journal.wallet_id = ?) as posting_count,
         (select count(*)::text from accounts
           where kind = 'PLAYER_BALANCE' and owner_id = ?) as player_account_count,
         event_type, payload
       from outbox_messages
       where aggregate_id = ?`,
        [walletId, walletId, walletId, walletId, walletId, walletId],
      );
    const row = rows[0];

    expect(row).toBeDefined();
    expect(row).toMatchObject({
      opening_count: '1',
      ledger_count: '1',
      journal_count: '1',
      posting_count: '2',
      player_account_count: '1',
      event_type: 'WalletOpened',
    });
    expect(row?.payload).toMatchObject({
      eventType: 'WalletOpened',
      aggregateId: walletId,
      version: 1,
      data: {
        walletId,
        initialBalance: { amount: '321.09', currency: 'BRL' },
        walletVersion: 1,
      },
    });
  });

  test('opens a zero-balance wallet without inventing a financial movement', async () => {
    const created = await postWallet(randomUUID(), '0.00');
    const walletId = String(created.body.id);
    const rows = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ ledger_count: string; opening_count: string; outbox_count: string }[]>(
        `select
         (select count(*)::text from wager_transactions where wallet_id = ?) as opening_count,
         (select count(*)::text from wallet_ledger_entries where wallet_id = ?) as ledger_count,
         (select count(*)::text from outbox_messages where aggregate_id = ?) as outbox_count`,
        [walletId, walletId, walletId],
      );

    expect(created.response.status).toBe(201);
    expect(created.body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(rows[0]).toEqual({ opening_count: '0', ledger_count: '0', outbox_count: '1' });
  });

  test('rolls back the actual wallet-opening use case when its failpoint fires', async () => {
    const countsSql = `select
      (select count(*)::text from wallets) as wallets,
      (select count(*)::text from wager_transactions) as transactions,
      (select count(*)::text from wallet_ledger_entries) as ledger_entries,
      (select count(*)::text from accounts) as accounts,
      (select count(*)::text from accounting_journals) as journals,
      (select count(*)::text from accounting_postings) as postings,
      (select count(*)::text from outbox_messages) as outbox_messages`;
    const before = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<Record<string, string>[]>(countsSql);
    const failpoints = FailpointController.create({ enabled: true, environment: 'test' });
    failpoints.arm('before_financial_commit');
    const runner = new MikroOrmTransactionRunner(
      getDatabaseContext().orm,
      createWalletTransactionContext,
    );
    const useCase = new CreateWalletUseCase(runner, { failpoints });
    const playerId = randomUUID();

    const error = await captureError(() =>
      useCase.execute({
        playerId,
        initialBalance: Money.create({ amount: '99.00', currency: 'BRL' }),
      }),
    );
    expect(error.message).toContain('Failpoint triggered: before_financial_commit');

    const after = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<Record<string, string>[]>(countsSql);

    expect(after).toEqual(before);
  });

  test('rejects direct SQL mutation of opening ledger and accounting history', async () => {
    const created = await postWallet(randomUUID(), '45.00');
    const walletId = String(created.body.id);
    const rows = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ entry_id: string; journal_id: string; posting_id: string }[]>(
        `select entry.id as entry_id, journal.id as journal_id, posting.id as posting_id
         from wallet_ledger_entries entry
         join accounting_journals journal on journal.transaction_id = entry.transaction_id
         join accounting_postings posting on posting.journal_id = journal.id
        where entry.wallet_id = ?
        order by posting.id
        limit 1`,
        [walletId],
      );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('Opening financial history is unavailable');
    }

    await expectDatabaseRejection(() =>
      getDatabaseContext()
        .orm.em.getConnection()
        .execute('update wallet_ledger_entries set amount_minor = 1 where id = ?', [row.entry_id]),
    );
    await expectDatabaseRejection(() =>
      getDatabaseContext()
        .orm.em.getConnection()
        .execute('delete from accounting_journals where id = ?', [row.journal_id]),
    );
    await expectDatabaseRejection(() =>
      getDatabaseContext()
        .orm.em.getConnection()
        .execute('update accounting_postings set amount_minor = 1 where id = ?', [row.posting_id]),
    );
  });
});
