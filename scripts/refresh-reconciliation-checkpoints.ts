import { MikroORM } from '@mikro-orm/postgresql';

import { createMikroOrmConfig } from '../src/bootstrap/configuration/mikro-orm.config.js';
import { parseEnvironment } from '../src/bootstrap/configuration/environment.schema.js';
import { MikroOrmTransactionRunner } from '../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import {
  IncrementalReconcileWalletUseCase,
  type IncrementalReconciliationTransactionContext,
} from '../src/wallet/application/incremental-reconcile-wallet.use-case.js';
import { createIncrementalReconciliationTransactionContext } from '../src/wallet/infrastructure/persistence/incremental-reconciliation-transaction-context.js';

export interface CheckpointRefreshOptions {
  readonly orm: MikroORM;
  readonly walletIds?: readonly string[];
}

export interface CheckpointRefreshResult {
  readonly schemaVersion: 1;
  readonly status: 'FAILED' | 'PASSED';
  readonly walletsChecked: number;
  readonly inconsistentWallets: number;
  readonly entriesScanned: number;
  readonly wallets: readonly Readonly<{
    walletId: string;
    consistent: boolean;
    checkpointStatus: string;
    entriesScanned: number;
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
    throw new TypeError('Checkpoint refresh scope contains an empty wallet identity');
  }
  return Object.freeze(normalized);
}

export async function refreshReconciliationCheckpoints(
  options: CheckpointRefreshOptions,
): Promise<CheckpointRefreshResult> {
  const walletIds = normalizeWalletIds(options.walletIds ?? (await listWalletIds(options.orm)));
  const runner = new MikroOrmTransactionRunner<IncrementalReconciliationTransactionContext>(
    options.orm,
    createIncrementalReconciliationTransactionContext,
  );
  const useCase = new IncrementalReconcileWalletUseCase(runner);
  const wallets = [];

  for (const walletId of walletIds) {
    const result = await useCase.execute(walletId);
    wallets.push(
      Object.freeze({
        walletId,
        consistent: result.consistent,
        checkpointStatus: result.checkpointStatus,
        entriesScanned: result.entriesScanned,
      }),
    );
  }

  const inconsistentWallets = wallets.filter(({ consistent }) => !consistent).length;
  return Object.freeze({
    schemaVersion: 1,
    status: inconsistentWallets === 0 ? 'PASSED' : 'FAILED',
    walletsChecked: wallets.length,
    inconsistentWallets,
    entriesScanned: wallets.reduce((total, wallet) => total + wallet.entriesScanned, 0),
    wallets: Object.freeze(wallets),
  });
}

function configuredWalletIds(): readonly string[] | undefined {
  const raw = process.env.RECONCILIATION_WALLET_IDS;
  return raw === undefined ? undefined : raw.split(',');
}

export async function runCheckpointRefreshCli(): Promise<number> {
  const environment = parseEnvironment();
  const orm = await MikroORM.init(createMikroOrmConfig(environment));
  try {
    const walletIds = configuredWalletIds();
    const result = await refreshReconciliationCheckpoints({
      orm,
      ...(walletIds === undefined ? {} : { walletIds }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'PASSED' ? 0 : 1;
  } catch {
    console.error('Reconciliation checkpoint refresh failed safely');
    return 1;
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  process.exitCode = await runCheckpointRefreshCli();
}
