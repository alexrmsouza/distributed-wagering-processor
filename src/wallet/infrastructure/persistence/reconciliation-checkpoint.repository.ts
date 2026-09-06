import type { EntityManager } from '@mikro-orm/core';

import {
  executeStatement,
  queryRows,
} from '../../../shared/infrastructure/persistence/transactional-query.js';
import type {
  ReconciliationCheckpoint,
  ReconciliationCheckpointRepository,
} from '../../application/ports/reconciliation-checkpoint.repository.js';
import type { WalletLedgerEntryState } from '../../domain/wallet-ledger-entry.js';
import {
  WalletLedgerEntryMapper,
  type WalletLedgerEntryDatabaseRow,
} from './wallet-ledger-entry.mapper.js';

interface ReconciliationCheckpointRow {
  readonly wallet_id: string;
  readonly currency: string;
  readonly ledger_sequence: string | bigint;
  readonly ledger_entry_hash: string | null;
  readonly calculated_balance_minor: string | bigint;
  readonly checked_at: Date;
}

const LEDGER_COLUMNS = `
  id, wallet_id, transaction_id, entry_sequence, direction, amount_minor,
  currency, balance_before_minor, balance_after_minor, previous_entry_hash,
  entry_hash, created_at
`;

export class MikroOrmReconciliationCheckpointRepository implements ReconciliationCheckpointRepository {
  public readonly transactionBound = true as const;

  public constructor(private readonly entityManager: EntityManager) {}

  public async findByWalletId(walletId: string): Promise<ReconciliationCheckpoint | null> {
    const rows = await queryRows<ReconciliationCheckpointRow>(
      this.entityManager,
      `select wallet_id, currency, ledger_sequence, ledger_entry_hash,
              calculated_balance_minor, checked_at
         from wallet_reconciliation_checkpoints
        where wallet_id = ?`,
      [walletId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : Object.freeze({
          walletId: row.wallet_id,
          currency: row.currency.trim(),
          ledgerSequence: BigInt(row.ledger_sequence),
          ledgerEntryHash: row.ledger_entry_hash,
          calculatedBalanceMinor: BigInt(row.calculated_balance_minor),
          checkedAt: new Date(row.checked_at),
        });
  }

  public async findLedgerEntry(
    walletId: string,
    sequence: bigint,
  ): Promise<WalletLedgerEntryState | null> {
    const rows = await queryRows<WalletLedgerEntryDatabaseRow>(
      this.entityManager,
      `select ${LEDGER_COLUMNS}
         from wallet_ledger_entries
        where wallet_id = ? and entry_sequence = ?`,
      [walletId, sequence.toString()],
    );
    const row = rows[0];
    return row === undefined ? null : WalletLedgerEntryMapper.toState(row);
  }

  public async listLedgerEntriesAfter(
    walletId: string,
    sequence: bigint,
  ): Promise<readonly WalletLedgerEntryState[]> {
    const rows = await queryRows<WalletLedgerEntryDatabaseRow>(
      this.entityManager,
      `select ${LEDGER_COLUMNS}
         from wallet_ledger_entries
        where wallet_id = ? and entry_sequence > ?
        order by entry_sequence`,
      [walletId, sequence.toString()],
    );
    return Object.freeze(rows.map((row) => WalletLedgerEntryMapper.toState(row)));
  }

  public save(checkpoint: ReconciliationCheckpoint): Promise<void> {
    return executeStatement(
      this.entityManager,
      `insert into wallet_reconciliation_checkpoints
         (wallet_id, currency, ledger_sequence, ledger_entry_hash,
          calculated_balance_minor, checked_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict (wallet_id) do update
         set currency = excluded.currency,
             ledger_sequence = excluded.ledger_sequence,
             ledger_entry_hash = excluded.ledger_entry_hash,
             calculated_balance_minor = excluded.calculated_balance_minor,
             checked_at = excluded.checked_at`,
      [
        checkpoint.walletId,
        checkpoint.currency,
        checkpoint.ledgerSequence.toString(),
        checkpoint.ledgerEntryHash,
        checkpoint.calculatedBalanceMinor.toString(),
        checkpoint.checkedAt,
      ],
    );
  }

  public deleteByWalletId(walletId: string): Promise<void> {
    return executeStatement(
      this.entityManager,
      'delete from wallet_reconciliation_checkpoints where wallet_id = ?',
      [walletId],
    );
  }
}
