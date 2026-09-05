import { Wallet } from '../../domain/wallet.js';

export interface WalletDatabaseRow {
  readonly id: string;
  readonly player_id: string;
  readonly currency: string;
  readonly balance_minor: string | bigint;
  readonly version: string | bigint;
  readonly ledger_sequence: string | bigint;
  readonly last_ledger_hash: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export const WalletMapper = {
  toDomain(row: WalletDatabaseRow): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      balanceMinor: BigInt(row.balance_minor),
      currency: row.currency.trim(),
      version: BigInt(row.version),
      ledgerSequence: BigInt(row.ledger_sequence),
      lastLedgerHash: row.last_ledger_hash?.trim() ?? null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  },
};
