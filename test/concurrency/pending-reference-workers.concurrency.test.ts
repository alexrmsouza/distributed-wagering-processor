import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';

import type { Clock } from '../../src/shared/application/clock.js';
import { Money } from '../../src/shared/domain/money.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import { createTestEnvironment } from '../support/test-environment.js';

const WORKER_SCRIPT = `
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from './src/bootstrap/configuration/mikro-orm.config.ts';
import { MikroOrmTransactionRunner } from './src/shared/infrastructure/mikro-orm-transaction-runner.ts';
import { ProcessWagerTransactionUseCase } from './src/wagering/application/process-wager-transaction.use-case.ts';
import { PendingReferenceWorker } from './src/wagering/infrastructure/pending-reference.worker.ts';
import { createWageringTransactionContext } from './src/wagering/infrastructure/persistence/wagering-transaction-context.ts';
import { NOOP_WALLET_LOCK_METRICS } from './src/wallet/application/ports/wallet-lock-metrics.ts';

const orm = await MikroORM.init(mikroOrmConfig);
try {
  const runner = new MikroOrmTransactionRunner(orm, (entityManager) =>
    createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS));
  const processWager = new ProcessWagerTransactionUseCase(runner);
  const result = await new PendingReferenceWorker(runner, processWager, { batchSize: 1 }).runOnce();
  process.stdout.write(JSON.stringify(result) + '\\n');
} finally {
  await orm.close(true);
}
`;

class FixedClock implements Clock {
  public constructor(private readonly instant: Date) {}
  public now(): Date {
    return new Date(this.instant);
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

async function runWorker(databaseName: string) {
  const environment = createTestEnvironment({ DATABASE_NAME: databaseName });
  const processHandle = Bun.spawn({
    cmd: [process.execPath, '--eval', WORKER_SCRIPT],
    cwd: process.cwd(),
    env: { ...process.env, ...environment.variables },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const output = await new Response(processHandle.stdout).text();
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) {
    throw new Error(`Pending reference worker exited with ${String(exitCode)}`);
  }
  return JSON.parse(output.trim()) as {
    readonly claimed: number;
    readonly processed: number;
    readonly rejected: number;
    readonly rescheduled: number;
    readonly skipped: number;
  };
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('pending_workers_concurrency');
  await databaseContext.orm.migrator.up();
});

afterAll(async () => {
  await databaseContext?.close();
});

test('two worker processes claim different pending references', async () => {
  const acceptedAt = new Date(Date.now() - 120_000);
  const clock = new FixedClock(acceptedAt);
  const wallet = await new CreateWalletUseCase(
    new MikroOrmTransactionRunner(context().orm, createWalletTransactionContext),
    { clock },
  ).execute({
    playerId: randomUUID(),
    initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
  });
  const { createWageringTransactionContext } =
    await import('../../src/wagering/infrastructure/persistence/wagering-transaction-context.js');
  const { NOOP_WALLET_LOCK_METRICS } =
    await import('../../src/wallet/application/ports/wallet-lock-metrics.js');
  const runner = new MikroOrmTransactionRunner(context().orm, (entityManager) =>
    createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
  );
  const processWager = new ProcessWagerTransactionUseCase(runner, { clock });
  await Promise.all(
    ['REFUND', 'ROLLBACK'].map((kind) =>
      processWager.execute({
        providerId: 'provider-a',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-worker-processes',
        gameId: 'fortune-chimp',
        kind: kind as 'REFUND' | 'ROLLBACK',
        money: Money.create({ amount: '25.00', currency: 'BRL' }),
        referenceExternalTransactionId: randomUUID(),
        correlationId: randomUUID(),
      }),
    ),
  );

  const results = await Promise.all([
    runWorker(context().databaseName),
    runWorker(context().databaseName),
  ]);

  expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(2);
  expect(results.reduce((sum, result) => sum + result.rescheduled, 0)).toBe(2);
  const rows = await context()
    .orm.em.getConnection()
    .execute<{ leases: string; retry_attempts: number; rows: string }[]>(
      `select retry_attempts, count(*)::text as rows,
            count(*) filter (where pending_lease_token is not null)::text as leases
       from wager_transactions
      where wallet_id = ? and status = 'PENDING_REFERENCE'
      group by retry_attempts`,
      [wallet.id],
    );
  expect(rows).toEqual([{ retry_attempts: 1, rows: '2', leases: '0' }]);
});
