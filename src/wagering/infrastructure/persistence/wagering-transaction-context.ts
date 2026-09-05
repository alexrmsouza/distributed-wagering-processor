import type { EntityManager } from '@mikro-orm/core';

import { MikroOrmAccountingRepository } from '../../../accounting/infrastructure/persistence/mikro-orm-accounting.repository.js';
import { MikroOrmOutboxRepository } from '../../../messaging/infrastructure/outbox.repository.js';
import { MikroOrmInboxRepository } from '../../../messaging/infrastructure/inbox.repository.js';
import type { WalletLockMetrics } from '../../../wallet/application/ports/wallet-lock-metrics.js';
import { MikroOrmWalletRepository } from '../../../wallet/infrastructure/persistence/mikro-orm-wallet.repository.js';
import type { WageringTransactionContext } from '../../application/ports/wagering-transaction-context.js';
import { MikroOrmPendingReferenceRepository } from './pending-reference.repository.js';
import { MikroOrmWagerTransactionRepository } from './wager-transaction.repository.js';

export function createWageringTransactionContext(
  entityManager: EntityManager,
  lockMetrics: WalletLockMetrics,
): WageringTransactionContext {
  const wagerTransactions = new MikroOrmWagerTransactionRepository(entityManager);
  return Object.freeze({
    inbox: new MikroOrmInboxRepository(entityManager),
    wallets: new MikroOrmWalletRepository(entityManager, lockMetrics),
    wagerTransactions,
    pendingReferences: new MikroOrmPendingReferenceRepository(entityManager),
    accounting: new MikroOrmAccountingRepository(entityManager),
    outbox: new MikroOrmOutboxRepository(entityManager),
  });
}
