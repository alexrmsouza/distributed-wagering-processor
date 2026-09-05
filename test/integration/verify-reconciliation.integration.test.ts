import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { Money } from '../../src/shared/domain/money.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';

let database: DatabaseTestContext | undefined;

function context(): DatabaseTestContext {
  if (database === undefined) {
    throw new Error('Reconciliation verification database is unavailable');
  }
  return database;
}

async function createWallet(amount: string): Promise<string> {
  const runner = new MikroOrmTransactionRunner(context().orm, createWalletTransactionContext);
  const wallet = await new CreateWalletUseCase(runner).execute({
    playerId: randomUUID(),
    initialBalance: Money.create({ amount, currency: 'BRL' }),
  });
  return wallet.id;
}

async function loadVerificationModule() {
  const exists = await Bun.file('scripts/verify-reconciliation.ts').exists();
  if (!exists) {
    expect(exists).toBeTrue();
  }
  return import('../../scripts/verify-reconciliation.js');
}

beforeAll(async () => {
  database = await createDatabaseTestContext('verify_reconciliation');
  await database.orm.migrator.up();
});

afterAll(async () => {
  await database?.close();
});

describe('reconciliation verification command', () => {
  test('checks every wallet and exits cleanly when all financial views agree', async () => {
    const module = (await loadVerificationModule()) as Record<string, unknown>;
    expect(module.verifyReconciliation).toBeFunction();
    const verifyReconciliation = module.verifyReconciliation as (options: {
      orm: DatabaseTestContext['orm'];
    }) => Promise<{
      status: string;
      walletsChecked: number;
      inconsistentWallets: number;
    }>;
    await Promise.all([createWallet('100.00'), createWallet('50.00')]);

    const result = await verifyReconciliation({ orm: context().orm });

    expect(result).toMatchObject({
      status: 'PASSED',
      scope: 'ALL_WALLETS',
      walletsChecked: 2,
      inconsistentWallets: 0,
    });
  });

  test('reports divergence without repairing the wallet', async () => {
    const { verifyReconciliation } = await loadVerificationModule();
    const walletId = await createWallet('25.00');
    const connection = context().orm.em.getConnection();
    await connection.execute('alter table wallets disable trigger wallets_ledger_head_consistent');
    try {
      await connection.execute('update wallets set balance_minor = 2600 where id = ?', [walletId]);
    } finally {
      await connection.execute('alter table wallets enable trigger wallets_ledger_head_consistent');
    }

    const result = await verifyReconciliation({ orm: context().orm, walletIds: [walletId] });
    const persisted = await connection.execute<{ balance_minor: string }[]>(
      'select balance_minor::text from wallets where id = ?',
      [walletId],
    );

    expect(result).toMatchObject({
      status: 'FAILED',
      scope: 'SELECTED_WALLETS',
      walletsChecked: 1,
      inconsistentWallets: 1,
    });
    expect(result.wallets[0]).toMatchObject({ walletId, consistent: false });
    expect(persisted[0]?.balance_minor).toBe('2600');
  });
});
