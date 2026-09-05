import type { TransactionBoundRepository } from '../../../shared/application/transaction-runner.js';
import type {
  WalletLedgerEntry,
  WalletLedgerEntryState,
} from '../../domain/wallet-ledger-entry.js';
import type { Wallet } from '../../domain/wallet.js';

export interface LedgerCursorPosition {
  readonly createdAt: Date;
  readonly id: string;
}

export interface LedgerPageQuery {
  readonly walletId: string;
  readonly after: LedgerCursorPosition | null;
  readonly limit: number;
}

export interface WalletRepository extends TransactionBoundRepository {
  findById(walletId: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  lockById(walletId: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  save(wallet: Wallet): Promise<void>;
  appendLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  listLedgerPage(query: LedgerPageQuery): Promise<readonly WalletLedgerEntry[]>;
  listLedgerStates(walletId: string): Promise<readonly WalletLedgerEntryState[]>;
}
