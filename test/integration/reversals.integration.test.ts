import { randomUUID } from 'node:crypto';

import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import { createTestEnvironment } from '../support/test-environment.js';

type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

interface WagerRequest {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string;
}

let application: INestApplication | undefined;
let baseUrl: string;
let databaseContext: DatabaseTestContext | undefined;

setDefaultTimeout(90_000);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function getDatabaseContext(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

async function requestJson(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (idempotencyKey !== undefined) {
    headers['idempotency-key'] = idempotencyKey;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { response, body: asRecord((await response.json()) as unknown) };
}

async function createWallet(amount = '100.00') {
  const playerId = randomUUID();
  const result = await requestJson('POST', '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(result.response.status).toBe(201);
  return { playerId, walletId: String(result.body.id) };
}

function createWager(
  wallet: { readonly playerId: string; readonly walletId: string },
  overrides: Partial<WagerRequest> = {},
): WagerRequest {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-reversal',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function postWager(request: WagerRequest, idempotencyKey = randomUUID()) {
  return requestJson('POST', '/wagering/transactions', request, idempotencyKey);
}

async function getWallet(walletId: string) {
  return requestJson('GET', `/wallets/${walletId}`);
}

beforeAll(async () => {
  const [{ WalletModule }, { WageringModule }] = await Promise.all([
    import('../../src/wallet/wallet.module.js'),
    import('../../src/wagering/wagering.module.js'),
  ]);
  const context = await createDatabaseTestContext('reversals');
  databaseContext = context;
  await context.orm.migrator.up();
  const environment = createTestEnvironment({ DATABASE_NAME: context.databaseName });
  const { createMikroOrmConfig } =
    await import('../../src/bootstrap/configuration/mikro-orm.config.js');

  @Module({
    imports: [
      MikroOrmModule.forRoot(createMikroOrmConfig(environment.configuration)),
      WalletModule,
      WageringModule,
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest uses this class as a module metadata root.
  class ReversalIntegrationTestModule {}

  application = await NestFactory.create(ReversalIntegrationTestModule, { logger: false });
  await application.listen(0, '127.0.0.1');
  baseUrl = await application.getUrl();
});

afterAll(async () => {
  await application?.close();
  await databaseContext?.close();
});

describe('Out-of-order reversals', () => {
  test.each([
    {
      reversalKind: 'REFUND' as const,
      sourceKind: 'BET' as const,
      balanceAfterSource: '75.00',
      reversalDirection: 'CREDIT',
    },
    {
      reversalKind: 'ROLLBACK' as const,
      sourceKind: 'WIN' as const,
      balanceAfterSource: '125.00',
      reversalDirection: 'DEBIT',
    },
  ])(
    'processes an out-of-order $reversalKind exactly once after its $sourceKind reference arrives',
    async (scenario) => {
      const wallet = await createWallet();
      const sourceExternalTransactionId = randomUUID();
      const reversal = createWager(wallet, {
        externalTransactionId: randomUUID(),
        kind: scenario.reversalKind,
        referenceExternalTransactionId: sourceExternalTransactionId,
      });
      const reversalIdempotencyKey = randomUUID();

      const pending = await postWager(reversal, reversalIdempotencyKey);
      expect(pending.response.status).toBe(202);
      expect(pending.body.transactionId).toBeString();
      expect(pending.body).toMatchObject({
        status: 'PENDING_REFERENCE',
        idempotentReplay: false,
      });
      const unchanged = await getWallet(wallet.walletId);
      expect(unchanged.body).toMatchObject({
        balance: { amount: '100.00', currency: 'BRL' },
        version: 1,
      });
      const pendingQuery = await requestJson(
        'GET',
        `/providers/${reversal.providerId}/wagering/transactions/${reversal.externalTransactionId}`,
      );
      expect(pendingQuery.response.status).toBe(200);
      expect(pendingQuery.body).toMatchObject({
        transactionId: pending.body.transactionId,
        status: 'PENDING_REFERENCE',
        referenceExternalTransactionId: sourceExternalTransactionId,
        referenceTransactionId: null,
        observedBalance: null,
      });
      const pendingScheduleBeforeReplay = await getDatabaseContext()
        .orm.em.getConnection()
        .execute<{ pending_events: string; retry_attempts: number; retry_expires_at: Date }[]>(
          `select transaction.retry_attempts, transaction.retry_expires_at,
                  count(message.id)::text as pending_events
             from wager_transactions transaction
             left join outbox_messages message
               on message.event_type = 'WagerTransactionPendingReference'
              and message.payload -> 'data' ->> 'transactionId' = transaction.id::text
            where transaction.id = ?
            group by transaction.retry_attempts, transaction.retry_expires_at`,
          [String(pending.body.transactionId)],
        );
      const pendingReplay = await postWager(reversal, reversalIdempotencyKey);
      expect(pendingReplay.response.status).toBe(202);
      expect(pendingReplay.body).toMatchObject({
        transactionId: pending.body.transactionId,
        status: 'PENDING_REFERENCE',
        idempotentReplay: true,
      });
      const pendingScheduleAfterReplay = await getDatabaseContext()
        .orm.em.getConnection()
        .execute<{ pending_events: string; retry_attempts: number; retry_expires_at: Date }[]>(
          `select transaction.retry_attempts, transaction.retry_expires_at,
                  count(message.id)::text as pending_events
             from wager_transactions transaction
             left join outbox_messages message
               on message.event_type = 'WagerTransactionPendingReference'
              and message.payload -> 'data' ->> 'transactionId' = transaction.id::text
            where transaction.id = ?
            group by transaction.retry_attempts, transaction.retry_expires_at`,
          [String(pending.body.transactionId)],
        );
      expect(pendingScheduleAfterReplay).toEqual(pendingScheduleBeforeReplay);

      const source = createWager(wallet, {
        externalTransactionId: sourceExternalTransactionId,
        kind: scenario.sourceKind,
      });
      const sourceResult = await postWager(source);
      expect(sourceResult.response.status).toBe(201);
      expect(sourceResult.body).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: scenario.balanceAfterSource, currency: 'BRL' },
      });

      const processed = await postWager(reversal, reversalIdempotencyKey);
      expect(processed.response.status).toBe(201);
      expect(processed.body).toEqual({
        transactionId: pending.body.transactionId,
        status: 'PROCESSED',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      const replay = await postWager(reversal, reversalIdempotencyKey);
      expect(replay.response.status).toBe(201);
      expect(replay.body).toEqual({ ...processed.body, idempotentReplay: true });

      const rows = await getDatabaseContext()
        .orm.em.getConnection()
        .execute<
          {
            direction: string;
            event_count: string;
            journal_count: string;
            ledger_count: string;
            reference_transaction_id: string;
            transaction_count: string;
          }[]
        >(
          `select transaction.reference_transaction_id::text,
             count(distinct transaction.id)::text as transaction_count,
             count(distinct entry.id)::text as ledger_count,
             count(distinct journal.id)::text as journal_count,
             count(distinct message.id)::text as event_count,
             min(entry.direction) as direction
           from wager_transactions transaction
           left join wallet_ledger_entries entry on entry.transaction_id = transaction.id
           left join accounting_journals journal on journal.transaction_id = transaction.id
           left join outbox_messages message
             on message.payload -> 'data' ->> 'transactionId' = transaction.id::text
          where transaction.id = ?
          group by transaction.reference_transaction_id`,
          [String(pending.body.transactionId)],
        );
      expect(rows[0]).toEqual({
        reference_transaction_id: String(sourceResult.body.transactionId),
        transaction_count: '1',
        ledger_count: '1',
        journal_count: '1',
        event_count: '3',
        direction: scenario.reversalDirection,
      });
    },
  );

  test('ROLLBACK applies the inverse of BET and REFUND', async () => {
    const wallet = await createWallet();
    const bet = createWager(wallet, { kind: 'BET' });
    const betResult = await postWager(bet);
    expect(betResult.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    const rollbackBet = createWager(wallet, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollbackBetResult = await postWager(rollbackBet);
    expect(rollbackBetResult.response.status).toBe(201);
    expect(rollbackBetResult.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const secondBet = createWager(wallet, { kind: 'BET' });
    expect((await postWager(secondBet)).body.balance).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
    const refund = createWager(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: secondBet.externalTransactionId,
    });
    const refundResult = await postWager(refund);
    expect(refundResult.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const rollbackRefund = createWager(wallet, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    const rollbackRefundResult = await postWager(rollbackRefund);
    expect(rollbackRefundResult.response.status).toBe(201);
    expect(rollbackRefundResult.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
    });

    const directions = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ direction: string; kind: string }[]>(
        `select transaction.kind, entry.direction
           from wager_transactions transaction
           join wallet_ledger_entries entry on entry.transaction_id = transaction.id
          where transaction.id in (?, ?)
          order by entry.direction`,
        [
          String(rollbackBetResult.body.transactionId),
          String(rollbackRefundResult.body.transactionId),
        ],
      );
    expect(directions).toEqual([
      { kind: 'ROLLBACK', direction: 'CREDIT' },
      { kind: 'ROLLBACK', direction: 'DEBIT' },
    ]);
  });

  test('rejects invalid reference context without changing either wallet', async () => {
    const sourceWallet = await createWallet();
    const otherWallet = await createWallet();
    const source = createWager(sourceWallet, { kind: 'BET' });
    expect((await postWager(source)).body.balance).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });

    const invalidRequests = [
      createWager(sourceWallet, {
        kind: 'REFUND',
        roundId: 'another-round',
        referenceExternalTransactionId: source.externalTransactionId,
      }),
      createWager(sourceWallet, {
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: source.externalTransactionId,
      }),
      createWager(otherWallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: source.externalTransactionId,
      }),
      createWager(sourceWallet, {
        providerId: 'provider-b',
        kind: 'REFUND',
        referenceExternalTransactionId: source.externalTransactionId,
      }),
    ];

    const results = await Promise.all(invalidRequests.map((request) => postWager(request)));
    for (const result of results) {
      expect(result.response.status).toBe(422);
      expect(result.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INVALID_REFERENCE',
        idempotentReplay: false,
      });
    }
    expect((await getWallet(sourceWallet.walletId)).body.balance).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
    expect((await getWallet(otherWallet.walletId)).body.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
  });

  test('returns 409 when one reversal idempotency key is reused with another payload', async () => {
    const wallet = await createWallet();
    const source = createWager(wallet, { kind: 'BET' });
    expect((await postWager(source)).response.status).toBe(201);
    const reversal = createWager(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: source.externalTransactionId,
    });
    const idempotencyKey = randomUUID();
    const initial = await postWager(reversal, idempotencyKey);
    const conflict = await postWager(
      { ...reversal, money: { amount: '20.00', currency: 'BRL' } },
      idempotencyKey,
    );

    expect(initial.response.status).toBe(201);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({ failureCode: 'IDEMPOTENCY_CONFLICT' });
    expect((await getWallet(wallet.walletId)).body.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
  });

  test('rejects a reversal that would overdraw without changing financial state', async () => {
    const wallet = await createWallet();
    const win = createWager(wallet, { kind: 'WIN' });
    const winResult = await postWager(win);
    expect(winResult.body.balance).toEqual({ amount: '125.00', currency: 'BRL' });
    const drain = createWager(wallet, {
      kind: 'BET',
      money: { amount: '125.00', currency: 'BRL' },
    });
    expect((await postWager(drain)).body.balance).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    const before = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<
        {
          balance_minor: string;
          journal_count: string;
          last_ledger_hash: string;
          ledger_count: string;
          ledger_sequence: string;
          version: string;
        }[]
      >(
        `select wallet.balance_minor::text, wallet.version::text,
              wallet.ledger_sequence::text, wallet.last_ledger_hash,
              count(distinct entry.id)::text as ledger_count,
              count(distinct journal.id)::text as journal_count
         from wallets wallet
         left join wallet_ledger_entries entry on entry.wallet_id = wallet.id
         left join accounting_journals journal on journal.wallet_id = wallet.id
        where wallet.id = ?
        group by wallet.balance_minor, wallet.version, wallet.ledger_sequence,
                 wallet.last_ledger_hash`,
        [wallet.walletId],
      );

    const rollback = createWager(wallet, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: win.externalTransactionId,
    });
    const result = await postWager(rollback);

    expect(result.response.status).toBe(422);
    expect(result.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_WOULD_OVERDRAW',
      balance: { amount: '0.00', currency: 'BRL' },
    });
    const after = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<
        {
          balance_minor: string;
          journal_count: string;
          last_ledger_hash: string;
          ledger_count: string;
          ledger_for_reversal: string;
          journals_for_reversal: string;
          balance_events: string;
          rejection_events: string;
          ledger_sequence: string;
          version: string;
        }[]
      >(
        `select wallet.balance_minor::text, wallet.version::text,
              wallet.ledger_sequence::text, wallet.last_ledger_hash,
              count(distinct entry.id)::text as ledger_count,
              count(distinct journal.id)::text as journal_count,
              count(distinct entry.id) filter (where entry.transaction_id = ?)::text
                as ledger_for_reversal,
              count(distinct journal.id) filter (where journal.transaction_id = ?)::text
                as journals_for_reversal,
              (select count(*)::text from outbox_messages
                where event_type = 'WalletBalanceChanged'
                  and payload -> 'data' ->> 'transactionId' = ?) as balance_events,
              (select count(*)::text from outbox_messages
                where event_type = 'WagerTransactionRejected'
                  and payload -> 'data' ->> 'transactionId' = ?) as rejection_events
         from wallets wallet
         left join wallet_ledger_entries entry on entry.wallet_id = wallet.id
         left join accounting_journals journal on journal.wallet_id = wallet.id
        where wallet.id = ?
        group by wallet.balance_minor, wallet.version, wallet.ledger_sequence,
                 wallet.last_ledger_hash`,
        [
          String(result.body.transactionId),
          String(result.body.transactionId),
          String(result.body.transactionId),
          String(result.body.transactionId),
          wallet.walletId,
        ],
      );
    const baseline = before[0];
    const outcome = after[0];
    expect(outcome).toMatchObject({
      ...baseline,
      ledger_for_reversal: '0',
      journals_for_reversal: '0',
      balance_events: '0',
      rejection_events: '1',
    });
  });
});
