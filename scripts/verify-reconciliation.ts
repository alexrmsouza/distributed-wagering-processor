import { MikroORM } from '@mikro-orm/postgresql';

import { createMikroOrmConfig } from '../src/bootstrap/configuration/mikro-orm.config.js';
import { parseEnvironment } from '../src/bootstrap/configuration/environment.schema.js';
import { MikroOrmTransactionRunner } from '../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { ReconcileWalletUseCase } from '../src/wallet/application/reconcile-wallet.use-case.js';
import { createWalletTransactionContext } from '../src/wallet/infrastructure/persistence/wallet-transaction-context.js';

export interface ReconciliationVerificationOptions {
  readonly orm: MikroORM;
  readonly walletIds?: readonly string[];
}

export interface ReconciliationVerificationResult {
  readonly schemaVersion: 1;
  readonly status: 'FAILED' | 'PASSED';
  readonly scope: 'ALL_WALLETS' | 'SELECTED_WALLETS';
  readonly walletsChecked: number;
  readonly inconsistentWallets: number;
  readonly wallets: readonly Readonly<{
    walletId: string;
    consistent: boolean;
    checkedEntries: number;
    accountingBalanced: boolean;
    auditChainValid: boolean;
  }>[];
}

async function listWalletIds(orm: MikroORM): Promise<readonly string[]> {
  const rows = await orm.em
    .getConnection()
    .execute<{ id: string }[]>('select id::text from wallets order by id');
  return Object.freeze(rows.map(({ id }) => id));
}

function normalizeWalletIds(walletIds: readonly string[]): readonly string[] {
  const normalized = [...new Set(walletIds.map((walletId) => walletId.trim()))].sort();
  if (normalized.some((walletId) => walletId.length === 0)) {
    throw new TypeError('Wallet verification scope contains an empty identity');
  }
  return Object.freeze(normalized);
}

export async function verifyReconciliation(
  options: ReconciliationVerificationOptions,
): Promise<ReconciliationVerificationResult> {
  const selected = options.walletIds !== undefined;
  const walletIds = normalizeWalletIds(options.walletIds ?? (await listWalletIds(options.orm)));
  const runner = new MikroOrmTransactionRunner(options.orm, createWalletTransactionContext);
  const useCase = new ReconcileWalletUseCase(runner);
  const results = [];
  for (const walletId of walletIds) {
    const result = await useCase.execute(walletId);
    results.push(
      Object.freeze({
        walletId,
        consistent: result.consistent,
        checkedEntries: result.checkedEntries,
        accountingBalanced: result.accountingBalanced,
        auditChainValid: result.auditChainValid,
      }),
    );
  }
  const inconsistentWallets = results.filter(({ consistent }) => !consistent).length;
  return Object.freeze({
    schemaVersion: 1,
    status: inconsistentWallets === 0 ? 'PASSED' : 'FAILED',
    scope: selected ? 'SELECTED_WALLETS' : 'ALL_WALLETS',
    walletsChecked: results.length,
    inconsistentWallets,
    wallets: Object.freeze(results),
  });
}

function configuredWalletIds(): readonly string[] | undefined {
  const raw = process.env.RECONCILIATION_WALLET_IDS;
  if (raw === undefined) {
    return undefined;
  }
  return raw.split(',').map((walletId) => walletId.trim());
}

export async function runReconciliationVerificationCli(): Promise<number> {
  const environment = parseEnvironment();
  const orm = await MikroORM.init(createMikroOrmConfig(environment));
  try {
    const walletIds = configuredWalletIds();
    const result = await verifyReconciliation({
      orm,
      ...(walletIds === undefined ? {} : { walletIds }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'PASSED' ? 0 : 1;
  } catch {
    console.error('Reconciliation verification failed safely');
    return 1;
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  process.exitCode = await runReconciliationVerificationCli();
}
