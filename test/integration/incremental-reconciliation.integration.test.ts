import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';

import { Money } from '../../src/shared/domain/money.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import {
  IncrementalReconcileWalletUseCase,
  type IncrementalReconciliationTransactionContext,
} from '../../src/wallet/application/incremental-reconcile-wallet.use-case.js';
import type { WalletTransactionContext } from '../../src/wallet/application/ports/wallet-transaction-context.js';
import { createIncrementalReconciliationTransactionContext } from '../../src/wallet/infrastructure/persistence/incremental-reconciliation-transaction-context.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';

let databaseContext: DatabaseTestContext | undefined;
let createWallet: CreateWalletUseCase | undefined;
let reconcileIncrementally: IncrementalReconcileWalletUseCase | undefined;

setDefaultTimeout(60_000);

function context(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('incremental_reconciliation');
  await databaseContext.orm.migrator.up();
  createWallet = new CreateWalletUseCase(
    new MikroOrmTransactionRunner<WalletTransactionContext>(
      databaseContext.orm,
      createWalletTransactionContext,
    ),
  );
  reconcileIncrementally = new IncrementalReconcileWalletUseCase(
    new MikroOrmTransactionRunner<IncrementalReconciliationTransactionContext>(
      databaseContext.orm,
      createIncrementalReconciliationTransactionContext,
    ),
  );
});

afterAll(async () => databaseContext?.close());

test('persists, validates, rebuilds, and invalidates reconciliation checkpoints', async () => {
  if (createWallet === undefined || reconcileIncrementally === undefined) {
    throw new Error('Reconciliation test use cases are unavailable');
  }
  const wallet = await createWallet.execute({
    playerId: randomUUID(),
    initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
    correlationId: randomUUID(),
  });

  const created = await reconcileIncrementally.execute(wallet.id);
  const unchanged = await reconcileIncrementally.execute(wallet.id);
  expect(created.checkpointStatus).toBe('CREATED');
  expect(created.entriesScanned).toBe(1);
  expect(unchanged.checkpointStatus).toBe('UNCHANGED');
  expect(unchanged.entriesScanned).toBe(0);

  await context()
    .orm.em.getConnection()
    .execute(
      `update wallet_reconciliation_checkpoints
        set ledger_entry_hash = ?
      where wallet_id = ?`,
      ['f'.repeat(64), wallet.id],
    );
  const rebuilt = await reconcileIncrementally.execute(wallet.id);
  expect(rebuilt.checkpointStatus).toBe('REBUILT');
  expect(rebuilt.entriesScanned).toBe(1);

  const connection = context().orm.em.getConnection();
  await connection.execute(
    'alter table wallet_ledger_entries disable trigger wallet_ledger_entries_immutable',
  );
  await connection.execute(
    'alter table wallet_ledger_entries disable trigger wallet_ledger_entries_head_consistent',
  );
  await connection.execute(
    'alter table wallet_ledger_entries disable trigger wallet_ledger_entries_financial_consistency',
  );
  try {
    await connection.execute(
      'update wallet_ledger_entries set entry_hash = ? where wallet_id = ?',
      ['e'.repeat(64), wallet.id],
    );
  } finally {
    await connection.execute(
      'alter table wallet_ledger_entries enable trigger wallet_ledger_entries_financial_consistency',
    );
    await connection.execute(
      'alter table wallet_ledger_entries enable trigger wallet_ledger_entries_head_consistent',
    );
    await connection.execute(
      'alter table wallet_ledger_entries enable trigger wallet_ledger_entries_immutable',
    );
  }

  const invalidated = await reconcileIncrementally.execute(wallet.id);
  expect(invalidated.checkpointStatus).toBe('INVALIDATED');
  expect(invalidated.consistent).toBe(false);
  const checkpoints = await connection.execute<{ count: string }[]>(
    'select count(*)::text as count from wallet_reconciliation_checkpoints where wallet_id = ?',
    [wallet.id],
  );
  expect(checkpoints[0]?.count).toBe('0');
});
