import type { AccountingRepository } from '../../../accounting/application/ports/accounting.repository.js';
import type { OutboxRepository } from '../../../messaging/application/outbox.repository.js';
import type { OpeningTransactionRepository } from './opening-transaction.repository.js';
import type { WalletRepository } from './wallet.repository.js';

export interface WalletTransactionContext {
  readonly wallets: WalletRepository;
  readonly openingTransactions: OpeningTransactionRepository;
  readonly accounting: AccountingRepository;
  readonly outbox: OutboxRepository;
}
