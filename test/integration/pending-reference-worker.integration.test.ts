import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import type { Clock } from '../../src/shared/application/clock.js';
import { Money } from '../../src/shared/domain/money.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import type { WageringTransactionContext } from '../../src/wagering/application/ports/wagering-transaction-context.js';
import { PendingReferenceWorker } from '../../src/wagering/infrastructure/pending-reference.worker.js';
import { createWageringTransactionContext } from '../../src/wagering/infrastructure/persistence/wagering-transaction-context.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import { NOOP_WALLET_LOCK_METRICS } from '../../src/wallet/application/ports/wallet-lock-metrics.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';

const ACCEPTED_AT = new Date('2026-09-04T12:00:00.000Z');
const FIRST_RETRY_AT = new Date('2026-09-04T12:00:30.000Z');
const EXPIRES_AT = new Date('2026-09-05T12:00:00.000Z');

class MutableClock implements Clock {
  public constructor(private instant: Date) {}

  public now(): Date {
    return new Date(this.instant);
  }

  public set(instant: Date): void {
    this.instant = new Date(instant);
  }
}

let databaseContext: DatabaseTestContext | undefined;

setDefaultTimeout(90_000);

function context(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

function wageringRunner() {
  return new MikroOrmTransactionRunner<WageringTransactionContext>(context().orm, (entityManager) =>
    createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
  );
}

async function createWallet(clock: Clock) {
  const useCase = new CreateWalletUseCase(
    new MikroOrmTransactionRunner(context().orm, createWalletTransactionContext),
    { clock },
  );
  return useCase.execute({
    playerId: randomUUID(),
    initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
  });
}

function command(
  wallet: { readonly id: string; readonly playerId: string },
  overrides: Partial<{
    readonly externalTransactionId: string;
    readonly idempotencyKey: string;
    readonly kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';
    readonly referenceExternalTransactionId: string;
  }> = {},
) {
  const externalTransactionId = overrides.externalTransactionId ?? randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-worker',
    gameId: 'fortune-chimp',
    kind: overrides.kind ?? ('BET' as const),
    money: Money.create({ amount: '25.00', currency: 'BRL' }),
    correlationId: randomUUID(),
    ...(overrides.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: overrides.referenceExternalTransactionId }),
  };
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('pending_worker');
  await databaseContext.orm.migrator.up();
});

afterAll(async () => {
  await databaseContext?.close();
});

describe('PendingReferenceWorker', () => {
  test('reclaims an expired lease and processes a reference exactly once', async () => {
    const clock = new MutableClock(ACCEPTED_AT);
    const runner = wageringRunner();
    const processWager = new ProcessWagerTransactionUseCase(runner, { clock });
    const wallet = await createWallet(clock);
    const referenceExternalTransactionId = randomUUID();
    const reversalCommand = command(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId,
    });
    const pending = await processWager.execute(reversalCommand);
    expect(pending.status).toBe('PENDING_REFERENCE');

    clock.set(FIRST_RETRY_AT);
    const abandonedLeaseToken = randomUUID();
    await runner.run(async ({ pendingReferences }) => {
      const claims = await pendingReferences.claimDue({
        now: clock.now(),
        leaseToken: abandonedLeaseToken,
        leaseExpiresAt: new Date(clock.now().getTime() + 1_000),
        limit: 1,
      });
      expect(claims).toHaveLength(1);
    });

    await processWager.execute(
      command(wallet, {
        externalTransactionId: referenceExternalTransactionId,
        kind: 'BET',
      }),
    );
    clock.set(new Date(FIRST_RETRY_AT.getTime() + 1_001));
    const worker = new PendingReferenceWorker(runner, processWager, {
      clock,
      generateLeaseToken: randomUUID,
      leaseDurationMs: 30_000,
      batchSize: 1,
    });

    const firstRun = await worker.runOnce();
    const secondRun = await worker.runOnce();

    expect(firstRun).toEqual({ claimed: 1, processed: 1, rejected: 0, rescheduled: 0, skipped: 0 });
    expect(secondRun).toEqual({
      claimed: 0,
      processed: 0,
      rejected: 0,
      rescheduled: 0,
      skipped: 0,
    });
    const rows = await context()
      .orm.em.getConnection()
      .execute<
        {
          balance_minor: string;
          event_count: string;
          ledger_count: string;
          status: string;
        }[]
      >(
        `select transaction.status, wallet.balance_minor::text,
              count(distinct entry.id)::text as ledger_count,
              count(distinct message.id)::text as event_count
         from wager_transactions transaction
         join wallets wallet on wallet.id = transaction.wallet_id
         left join wallet_ledger_entries entry on entry.transaction_id = transaction.id
         left join outbox_messages message
           on message.payload -> 'data' ->> 'transactionId' = transaction.id::text
        where transaction.id = ?
        group by transaction.status, wallet.balance_minor`,
        [pending.transactionId],
      );
    expect(rows[0]).toEqual({
      status: 'PROCESSED',
      balance_minor: '10000',
      ledger_count: '1',
      event_count: '3',
    });
  });

  test('expires at 24 hours and emits one terminal rejection event', async () => {
    const clock = new MutableClock(ACCEPTED_AT);
    const runner = wageringRunner();
    const processWager = new ProcessWagerTransactionUseCase(runner, { clock });
    const wallet = await createWallet(clock);
    const pending = await processWager.execute(
      command(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: randomUUID() }),
    );
    clock.set(EXPIRES_AT);
    const worker = new PendingReferenceWorker(runner, processWager, {
      clock,
      generateLeaseToken: randomUUID,
      batchSize: 10,
    });

    const firstRun = await worker.runOnce();
    const secondRun = await worker.runOnce();

    expect(firstRun).toEqual({ claimed: 1, processed: 0, rejected: 1, rescheduled: 0, skipped: 0 });
    expect(secondRun.claimed).toBe(0);
    const rows = await context()
      .orm.em.getConnection()
      .execute<{ event_type: string; occurrences: string; failure_code: string; status: string }[]>(
        `select transaction.status, transaction.failure_code, message.event_type,
              count(*)::text as occurrences
         from wager_transactions transaction
         join outbox_messages message
           on message.payload -> 'data' ->> 'transactionId' = transaction.id::text
        where transaction.id = ?
        group by transaction.status, transaction.failure_code, message.event_type
        order by message.event_type`,
        [pending.transactionId],
      );
    expect(rows).toEqual([
      {
        status: 'REJECTED',
        failure_code: 'REFERENCE_NOT_FOUND',
        event_type: 'WagerTransactionPendingReference',
        occurrences: '1',
      },
      {
        status: 'REJECTED',
        failure_code: 'REFERENCE_NOT_FOUND',
        event_type: 'WagerTransactionRejected',
        occurrences: '1',
      },
    ]);
  });

  test('parallel workers claim distinct due rows through SKIP LOCKED', async () => {
    const clock = new MutableClock(ACCEPTED_AT);
    const runner = wageringRunner();
    const processWager = new ProcessWagerTransactionUseCase(runner, { clock });
    const wallet = await createWallet(clock);
    await Promise.all([
      processWager.execute(
        command(wallet, { kind: 'REFUND', referenceExternalTransactionId: randomUUID() }),
      ),
      processWager.execute(
        command(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: randomUUID() }),
      ),
    ]);
    clock.set(FIRST_RETRY_AT);
    const workers = [
      new PendingReferenceWorker(runner, processWager, {
        clock,
        generateLeaseToken: randomUUID,
        batchSize: 1,
      }),
      new PendingReferenceWorker(runner, processWager, {
        clock,
        generateLeaseToken: randomUUID,
        batchSize: 1,
      }),
    ];

    const runs = await Promise.all(workers.map((worker) => worker.runOnce()));

    expect(runs.reduce((total, result) => total + result.claimed, 0)).toBe(2);
    expect(runs.reduce((total, result) => total + result.rescheduled, 0)).toBe(2);
    const rows = await context()
      .orm.em.getConnection()
      .execute<{ retry_attempts: number; rows: string }[]>(
        `select retry_attempts, count(*)::text as rows
         from wager_transactions
        where wallet_id = ? and status = 'PENDING_REFERENCE'
        group by retry_attempts`,
        [wallet.id],
      );
    expect(rows).toEqual([{ retry_attempts: 1, rows: '2' }]);
  });
});
