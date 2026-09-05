import {
  WalletLedgerEntry,
  type WalletLedgerEntryState,
} from '../../domain/wallet-ledger-entry.js';

export interface WalletLedgerEntryDatabaseRow {
  readonly id: string;
  readonly wallet_id: string;
  readonly transaction_id: string;
  readonly entry_sequence: string | bigint;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount_minor: string | bigint;
  readonly currency: string;
  readonly balance_before_minor: string | bigint;
  readonly balance_after_minor: string | bigint;
  readonly previous_entry_hash: string | null;
  readonly entry_hash: string;
  readonly created_at: Date;
}

export const WalletLedgerEntryMapper = {
  toState(row: WalletLedgerEntryDatabaseRow): WalletLedgerEntryState {
    return Object.freeze({
      id: row.id,
      walletId: row.wallet_id,
      transactionId: row.transaction_id,
      entrySequence: BigInt(row.entry_sequence),
      direction: row.direction,
      amountMinor: BigInt(row.amount_minor),
      currency: row.currency.trim(),
      balanceBeforeMinor: BigInt(row.balance_before_minor),
      balanceAfterMinor: BigInt(row.balance_after_minor),
      previousEntryHash: row.previous_entry_hash?.trim() ?? null,
      entryHash: row.entry_hash.trim(),
      createdAt: new Date(row.created_at),
    });
  },

  toDomain(row: WalletLedgerEntryDatabaseRow): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate(WalletLedgerEntryMapper.toState(row));
  },
};
