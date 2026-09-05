import { randomUUID } from 'node:crypto';

import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { GetProviderWagerTransactionUseCase } from '../../src/wagering/application/get-provider-wager-transaction.use-case.js';
import { GetWagerTransactionUseCase } from '../../src/wagering/application/get-wager-transaction.use-case.js';
import type { WageringTransactionContext } from '../../src/wagering/application/ports/wagering-transaction-context.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { PendingReferenceWorker } from '../../src/wagering/infrastructure/pending-reference.worker.js';
import { createWageringTransactionContext } from '../../src/wagering/infrastructure/persistence/wagering-transaction-context.js';
import { WageringAuthenticationGuard } from '../../src/wagering/presentation/wagering-authentication.guard.js';
import { WageringController } from '../../src/wagering/presentation/wagering.controller.js';
import type { Clock } from '../../src/shared/application/clock.js';
import type { TransactionRunner } from '../../src/shared/application/transaction-runner.js';
import { Money } from '../../src/shared/domain/money.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { AUTHENTICATION_GUARD } from '../../src/shared/infrastructure/no-op-auth.guard.js';
import { NOOP_WALLET_LOCK_METRICS } from '../../src/wallet/application/ports/wallet-lock-metrics.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';

const ACCEPTED_AT = new Date('2026-09-04T12:00:00.000Z');
const FIRST_RETRY_AT = new Date('2026-09-04T12:00:30.000Z');
const EXPIRES_AT = new Date('2026-09-05T12:00:00.000Z');

type ReversalKind = 'REFUND' | 'ROLLBACK';
type WagerKind = 'BET' | 'WIN' | 'LOSS' | ReversalKind;

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

interface TestWallet {
  readonly id: string;
  readonly playerId: string;
}

class MutableClock implements Clock {
  public constructor(private instant: Date) {}

  public now(): Date {
    return new Date(this.instant);
  }

  public set(instant: Date): void {
    this.instant = new Date(instant);
  }
}

let application: INestApplication | undefined;
let baseUrl = '';
let databaseContext: DatabaseTestContext | undefined;
let processWagerTransaction: ProcessWagerTransactionUseCase | undefined;
let wageringRunner: TransactionRunner<WageringTransactionContext> | undefined;
const clock = new MutableClock(ACCEPTED_AT);

setDefaultTimeout(90_000);

function database(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

function runner(): TransactionRunner<WageringTransactionContext> {
  if (wageringRunner === undefined) {
    throw new Error('Wagering transaction runner is unavailable');
  }
  return wageringRunner;
}

function processor(): ProcessWagerTransactionUseCase {
  if (processWagerTransaction === undefined) {
    throw new Error('Wager transaction processor is unavailable');
  }
  return processWagerTransaction;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }
  return value as Record<string, unknown>;
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

async function createWallet(): Promise<TestWallet> {
  const wallet = await new CreateWalletUseCase(
    new MikroOrmTransactionRunner(database().orm, createWalletTransactionContext),
    { clock },
  ).execute({
    playerId: randomUUID(),
    initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
  });

  return { id: wallet.id, playerId: wallet.playerId };
}

function wager(wallet: TestWallet, overrides: Partial<WagerRequest> = {}): WagerRequest {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-pending-reference-edge-cases',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function postWager(request: WagerRequest, idempotencyKey = randomUUID()) {
  return requestJson('POST', '/wagering/transactions', request, idempotencyKey);
}

async function eventTypes(transactionId: string): Promise<readonly string[]> {
  const rows = await database()
    .orm.em.getConnection()
    .execute<{ event_type: string }[]>(
      `select event_type
         from outbox_messages
        where payload -> 'data' ->> 'transactionId' = ?
        order by event_type`,
      [transactionId],
    );

  return rows.map(({ event_type }) => event_type);
}

async function financialEffectCounts(transactionId: string) {
  const rows = await database()
    .orm.em.getConnection()
    .execute<{ journal_count: string; ledger_count: string }[]>(
      `select count(distinct entry.id)::text as ledger_count,
              count(distinct journal.id)::text as journal_count
         from wager_transactions transaction
         left join wallet_ledger_entries entry on entry.transaction_id = transaction.id
         left join accounting_journals journal on journal.transaction_id = transaction.id
        where transaction.id = ?`,
      [transactionId],
    );

  return rows[0];
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('pending_reference_edge_cases');
  await databaseContext.orm.migrator.up();
  wageringRunner = new MikroOrmTransactionRunner<WageringTransactionContext>(
    databaseContext.orm,
    (entityManager) => createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
  );
  processWagerTransaction = new ProcessWagerTransactionUseCase(wageringRunner, { clock });
  const getWagerTransaction = new GetWagerTransactionUseCase(wageringRunner);
  const getProviderWagerTransaction = new GetProviderWagerTransactionUseCase(wageringRunner);

  @Module({
    controllers: [WageringController],
    providers: [
      WageringAuthenticationGuard,
      {
        provide: AUTHENTICATION_GUARD,
        useValue: { canActivate: () => true },
      },
      {
        provide: ProcessWagerTransactionUseCase,
        useValue: processWagerTransaction,
      },
      {
        provide: GetWagerTransactionUseCase,
        useValue: getWagerTransaction,
      },
      {
        provide: GetProviderWagerTransactionUseCase,
        useValue: getProviderWagerTransaction,
      },
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest uses module metadata at runtime.
  class PendingReferenceEdgeCasesTestModule {}

  application = await NestFactory.create(PendingReferenceEdgeCasesTestModule, { logger: false });
  await application.listen(0, '127.0.0.1');
  baseUrl = await application.getUrl();
});

afterAll(async () => {
  await application?.close();
  await databaseContext?.close();
});

describe('Pending-reference edge-case invariants', () => {
  test('HTTP replay expires a pending reversal before considering a late reference', async () => {
    clock.set(ACCEPTED_AT);
    const wallet = await createWallet();
    const sourceExternalTransactionId = randomUUID();
    const reversal = wager(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: sourceExternalTransactionId,
    });
    const idempotencyKey = randomUUID();

    const pending = await postWager(reversal, idempotencyKey);

    expect(pending.response.status).toBe(202);
    expect(pending.body).toMatchObject({ status: 'PENDING_REFERENCE' });
    const transactionId = String(pending.body.transactionId);
    const schedules = await database()
      .orm.em.getConnection()
      .execute<{ retry_expires_at: string }[]>(
        `select retry_expires_at
           from wager_transactions
          where id = ?`,
        [transactionId],
      );
    expect(new Date(schedules[0]?.retry_expires_at ?? '')).toEqual(EXPIRES_AT);

    clock.set(EXPIRES_AT);
    const lateSource = await postWager(
      wager(wallet, {
        providerId: reversal.providerId,
        externalTransactionId: sourceExternalTransactionId,
        roundId: reversal.roundId,
        kind: 'BET',
      }),
    );
    expect(lateSource.response.status).toBe(201);

    const expired = await postWager(reversal, idempotencyKey);

    expect(expired.response.status).toBe(422);
    expect(expired.body).toMatchObject({
      transactionId,
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await financialEffectCounts(transactionId)).toEqual({
      ledger_count: '0',
      journal_count: '0',
    });
    expect(await eventTypes(transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });

  test('worker rejects a foreign-provider reference that appears after pending acceptance', async () => {
    clock.set(ACCEPTED_AT);
    const wallet = await createWallet();
    const sourceExternalTransactionId = randomUUID();
    const reversal = wager(wallet, {
      providerId: 'provider-a',
      kind: 'REFUND',
      referenceExternalTransactionId: sourceExternalTransactionId,
    });
    const pending = await postWager(reversal);
    expect(pending.response.status).toBe(202);
    const transactionId = String(pending.body.transactionId);

    const foreignSource = await postWager(
      wager(wallet, {
        providerId: 'provider-b',
        externalTransactionId: sourceExternalTransactionId,
        roundId: reversal.roundId,
        kind: 'BET',
      }),
    );
    expect(foreignSource.response.status).toBe(201);
    clock.set(FIRST_RETRY_AT);
    const worker = new PendingReferenceWorker(runner(), processor(), {
      clock,
      generateLeaseToken: randomUUID,
      batchSize: 1,
    });

    const run = await worker.runOnce();

    expect(run).toEqual({ claimed: 1, processed: 0, rejected: 1, rescheduled: 0, skipped: 0 });
    const rows = await database()
      .orm.em.getConnection()
      .execute<{ failure_code: string; status: string }[]>(
        `select status, failure_code
           from wager_transactions
          where id = ?`,
        [transactionId],
      );
    expect(rows[0]).toEqual({ status: 'REJECTED', failure_code: 'INVALID_REFERENCE' });
    expect(await financialEffectCounts(transactionId)).toEqual({
      ledger_count: '0',
      journal_count: '0',
    });
    expect(await eventTypes(transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });

  test.each(['REFUND', 'ROLLBACK'] as const)(
    'rejects self-referencing %s without emitting a pending-reference event',
    async (kind) => {
      clock.set(ACCEPTED_AT);
      const wallet = await createWallet();
      const externalTransactionId = randomUUID();
      const reversal = wager(wallet, {
        externalTransactionId,
        kind,
        referenceExternalTransactionId: externalTransactionId,
      });

      const rejected = await postWager(reversal);

      expect(rejected.response.status).toBe(422);
      expect(rejected.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INVALID_REFERENCE',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      const transactionId = String(rejected.body.transactionId);
      const rows = await database()
        .orm.em.getConnection()
        .execute<{ failure_code: string; status: string }[]>(
          `select status, failure_code
             from wager_transactions
            where id = ?`,
          [transactionId],
        );
      expect(rows[0]).toEqual({ status: 'REJECTED', failure_code: 'INVALID_REFERENCE' });
      expect(await financialEffectCounts(transactionId)).toEqual({
        ledger_count: '0',
        journal_count: '0',
      });
      expect(await eventTypes(transactionId)).toEqual(['WagerTransactionRejected']);
    },
  );
});
