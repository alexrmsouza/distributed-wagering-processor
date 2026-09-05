import type { EntityManager } from '@mikro-orm/core';

import {
  executeStatement,
  queryRows,
} from '../../../shared/infrastructure/persistence/transactional-query.js';
import type {
  LedgerPageQuery,
  WalletRepository,
} from '../../application/ports/wallet.repository.js';
import {
  NOOP_WALLET_LOCK_METRICS,
  type WalletLockMetrics,
} from '../../application/ports/wallet-lock-metrics.js';
import { WalletAlreadyExistsError } from '../../application/wallet-errors.js';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import type { Wallet } from '../../domain/wallet.js';
import {
  WalletLedgerEntryMapper,
  type WalletLedgerEntryDatabaseRow,
} from './wallet-ledger-entry.mapper.js';
import { WalletMapper, type WalletDatabaseRow } from './wallet.mapper.js';

const WALLET_COLUMNS = `
  id, player_id, currency, balance_minor, version, ledger_sequence,
  last_ledger_hash, created_at, updated_at
`;
const LEDGER_COLUMNS = `
  id, wallet_id, transaction_id, entry_sequence, direction, amount_minor,
  currency, balance_before_minor, balance_after_minor, previous_entry_hash,
  entry_hash, created_at
`;

function isDuplicateWalletError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const databaseError = error as Error & { code?: string; constraint?: string };
  return (
    databaseError.code === '23505' ||
    databaseError.constraint === 'wallets_player_currency_unique' ||
    error.message.includes('wallets_player_currency_unique')
  );
}

export class MikroOrmWalletRepository implements WalletRepository {
  public readonly transactionBound = true as const;

  public constructor(
    private readonly entityManager: EntityManager,
    private readonly lockMetrics: WalletLockMetrics = NOOP_WALLET_LOCK_METRICS,
  ) {}

  public async findById(walletId: string): Promise<Wallet | null> {
    return this.findOne(`select ${WALLET_COLUMNS} from wallets where id = ?`, [walletId]);
  }

  public async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    return this.findOne(
      `select ${WALLET_COLUMNS} from wallets where player_id = ? and currency = ?`,
      [playerId, currency],
    );
  }

  public async lockById(walletId: string): Promise<Wallet | null> {
    const startedAt = performance.now();

    try {
      const wallet = await this.findOne(
        `select ${WALLET_COLUMNS} from wallets where id = ? for update`,
        [walletId],
      );
      this.observeLockWait(
        (performance.now() - startedAt) / 1_000,
        wallet === null ? 'not_found' : 'acquired',
      );
      return wallet;
    } catch (error: unknown) {
      this.observeLockWait((performance.now() - startedAt) / 1_000, 'failed');
      try {
        this.lockMetrics.recordConflict?.();
      } catch {
        // Telemetry must not replace the original lock failure.
      }
      throw error;
    }
  }

  public async insert(wallet: Wallet): Promise<void> {
    const state = wallet.toState();

    try {
      await executeStatement(
        this.entityManager,
        `insert into wallets
           (id, player_id, currency, balance_minor, version, ledger_sequence,
            last_ledger_hash, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          state.id,
          state.playerId,
          state.currency,
          state.balanceMinor.toString(),
          state.version.toString(),
          state.ledgerSequence.toString(),
          state.lastLedgerHash,
          state.createdAt,
          state.updatedAt,
        ],
      );
    } catch (error: unknown) {
      if (isDuplicateWalletError(error)) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }

  public async save(wallet: Wallet): Promise<void> {
    const state = wallet.toState();
    await executeStatement(
      this.entityManager,
      `update wallets
          set balance_minor = ?, version = ?, ledger_sequence = ?, last_ledger_hash = ?,
              updated_at = ?
        where id = ?`,
      [
        state.balanceMinor.toString(),
        state.version.toString(),
        state.ledgerSequence.toString(),
        state.lastLedgerHash,
        state.updatedAt,
        state.id,
      ],
    );
  }

  public async appendLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    const state = entry.toState();
    await executeStatement(
      this.entityManager,
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, entry_sequence, direction, amount_minor,
          currency, balance_before_minor, balance_after_minor, previous_entry_hash,
          entry_hash, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        state.id,
        state.walletId,
        state.transactionId,
        state.entrySequence.toString(),
        state.direction,
        state.amountMinor.toString(),
        state.currency,
        state.balanceBeforeMinor.toString(),
        state.balanceAfterMinor.toString(),
        state.previousEntryHash,
        state.entryHash,
        state.createdAt,
      ],
    );
  }

  public async listLedgerPage(query: LedgerPageQuery): Promise<readonly WalletLedgerEntry[]> {
    const parameters: unknown[] = [query.walletId];
    let cursorPredicate = '';

    if (query.after !== null) {
      cursorPredicate = 'and (created_at, id) > (?, ?::uuid)';
      parameters.push(query.after.createdAt, query.after.id);
    }
    parameters.push(query.limit);

    const rows = await queryRows<WalletLedgerEntryDatabaseRow>(
      this.entityManager,
      `select ${LEDGER_COLUMNS}
         from wallet_ledger_entries
        where wallet_id = ? ${cursorPredicate}
        order by created_at, id
        limit ?`,
      parameters,
    );

    return Object.freeze(rows.map((row) => WalletLedgerEntryMapper.toDomain(row)));
  }

  public async listLedgerStates(walletId: string) {
    const rows = await queryRows<WalletLedgerEntryDatabaseRow>(
      this.entityManager,
      `select ${LEDGER_COLUMNS}
         from wallet_ledger_entries
        where wallet_id = ?
        order by entry_sequence`,
      [walletId],
    );

    return Object.freeze(rows.map((row) => WalletLedgerEntryMapper.toState(row)));
  }

  private async findOne(sql: string, parameters: readonly unknown[]): Promise<Wallet | null> {
    const rows = await queryRows<WalletDatabaseRow>(this.entityManager, sql, parameters);
    const row = rows[0];
    return row === undefined ? null : WalletMapper.toDomain(row);
  }

  private observeLockWait(
    durationSeconds: number,
    outcome: 'acquired' | 'failed' | 'not_found',
  ): void {
    try {
      this.lockMetrics.observeWait(durationSeconds, outcome);
    } catch {
      // Telemetry must not change wallet-lock correctness.
    }
  }
}
