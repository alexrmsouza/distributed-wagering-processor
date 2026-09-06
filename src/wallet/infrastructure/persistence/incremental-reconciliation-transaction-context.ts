import type { EntityManager } from '@mikro-orm/core';

import { MikroOrmAccountingRepository } from '../../../accounting/infrastructure/persistence/mikro-orm-accounting.repository.js';
import type { IncrementalReconciliationTransactionContext } from '../../application/incremental-reconcile-wallet.use-case.js';
import { MikroOrmReconciliationCheckpointRepository } from './reconciliation-checkpoint.repository.js';
import { MikroOrmWalletRepository } from './mikro-orm-wallet.repository.js';

export function createIncrementalReconciliationTransactionContext(
  entityManager: EntityManager,
): IncrementalReconciliationTransactionContext {
  return Object.freeze({
    wallets: new MikroOrmWalletRepository(entityManager),
    accounting: new MikroOrmAccountingRepository(entityManager),
    reconciliationCheckpoints: new MikroOrmReconciliationCheckpointRepository(entityManager),
  });
}
