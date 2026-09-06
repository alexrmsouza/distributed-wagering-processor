import type { TransactionBoundRepository } from '../../../shared/application/transaction-runner.js';
import type { WalletLedgerEntryState } from '../../domain/wallet-ledger-entry.js';

export interface ReconciliationCheckpoint {
  readonly walletId: string;
  readonly currency: string;
  readonly ledgerSequence: bigint;
  readonly ledgerEntryHash: string | null;
  readonly calculatedBalanceMinor: bigint;
  readonly checkedAt: Date;
}

export interface ReconciliationCheckpointRepository extends TransactionBoundRepository {
  findByWalletId(walletId: string): Promise<ReconciliationCheckpoint | null>;
  findLedgerEntry(walletId: string, sequence: bigint): Promise<WalletLedgerEntryState | null>;
  listLedgerEntriesAfter(
    walletId: string,
    sequence: bigint,
  ): Promise<readonly WalletLedgerEntryState[]>;
  save(checkpoint: ReconciliationCheckpoint): Promise<void>;
  deleteByWalletId(walletId: string): Promise<void>;
}
