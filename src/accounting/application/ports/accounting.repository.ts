import type { TransactionBoundRepository } from '../../../shared/application/transaction-runner.js';
import type { Account, AccountKind } from '../../domain/account.js';
import type { AccountingJournal } from '../../domain/accounting-journal.js';
import type { PostingDirection } from '../../domain/accounting-posting.js';

export interface WalletAccountingPosting {
  readonly journalId: string;
  readonly accountKind: AccountKind;
  readonly accountOwnerId: string;
  readonly direction: PostingDirection;
  readonly amountMinor: bigint;
  readonly currency: string;
}

export interface AccountingRepository extends TransactionBoundRepository {
  getOrCreateAccount(account: Account): Promise<Account>;
  insertJournal(journal: AccountingJournal): Promise<void>;
  listWalletPostings(walletId: string): Promise<readonly WalletAccountingPosting[]>;
}
