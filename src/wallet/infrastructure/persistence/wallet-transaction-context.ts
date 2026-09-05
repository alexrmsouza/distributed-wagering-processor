import type { EntityManager } from '@mikro-orm/core';

import { MikroOrmAccountingRepository } from '../../../accounting/infrastructure/persistence/mikro-orm-accounting.repository.js';
import { MikroOrmOutboxRepository } from '../../../messaging/infrastructure/outbox.repository.js';
import type { WalletTransactionContext } from '../../application/ports/wallet-transaction-context.js';
import { MikroOrmOpeningTransactionRepository } from './mikro-orm-opening-transaction.repository.js';
import { MikroOrmWalletRepository } from './mikro-orm-wallet.repository.js';

export function createWalletTransactionContext(
  entityManager: EntityManager,
): WalletTransactionContext {
  return Object.freeze({
    wallets: new MikroOrmWalletRepository(entityManager),
    openingTransactions: new MikroOrmOpeningTransactionRepository(entityManager),
    accounting: new MikroOrmAccountingRepository(entityManager),
    outbox: new MikroOrmOutboxRepository(entityManager),
  });
}
