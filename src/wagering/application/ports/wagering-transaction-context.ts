import type { AccountingRepository } from '../../../accounting/application/ports/accounting.repository.js';
import type { OutboxRepository } from '../../../messaging/application/outbox.repository.js';
import type { InboxRepository } from '../../../messaging/application/inbox.repository.js';
import type { WalletRepository } from '../../../wallet/application/ports/wallet.repository.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import type { WagerTransactionRepository } from './wager-transaction.repository.js';
import type { PendingReferenceRepository } from './pending-reference.repository.js';

export interface WageringTransactionContext {
  readonly inbox: InboxRepository;
  readonly wallets: WalletRepository;
  readonly wagerTransactions: WagerTransactionRepository<WagerTransaction>;
  readonly pendingReferences: PendingReferenceRepository;
  readonly accounting: AccountingRepository;
  readonly outbox: OutboxRepository;
}
