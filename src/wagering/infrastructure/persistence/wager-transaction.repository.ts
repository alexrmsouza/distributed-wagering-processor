import type { EntityManager } from '@mikro-orm/core';

import {
  executeStatement,
  queryRows,
} from '../../../shared/infrastructure/persistence/transactional-query.js';
import type { WagerTransactionRepository } from '../../application/ports/wager-transaction.repository.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import {
  WagerTransactionMapper,
  type WagerTransactionDatabaseRow,
} from './wager-transaction.mapper.js';

const TRANSACTION_COLUMNS = `
  id, provider_id, external_transaction_id, idempotency_key, payload_hash,
  wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
  reference_external_transaction_id, reference_transaction_id, status,
  failure_code, observed_balance_minor, observed_balance_currency, retry_attempts, next_retry_at,
  retry_expires_at, processed_at, created_at, updated_at
`;

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository<WagerTransaction> {
  public readonly transactionBound = true as const;

  public constructor(private readonly entityManager: EntityManager) {}

  public findById(transactionId: string, lock = false): Promise<WagerTransaction | null> {
    return this.findOne(
      `select ${TRANSACTION_COLUMNS} from wager_transactions where id = ?${lock ? ' for update' : ''}`,
      [transactionId],
    );
  }

  public findByExternalId(externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.findOne(
      `select ${TRANSACTION_COLUMNS}
         from wager_transactions
        where external_transaction_id = ?
        order by created_at, id
        limit 1`,
      [externalTransactionId],
    );
  }

  public findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
    lock = false,
  ): Promise<WagerTransaction | null> {
    return this.findOne(
      `select ${TRANSACTION_COLUMNS}
         from wager_transactions
        where provider_id = ? and external_transaction_id = ?${lock ? ' for update' : ''}`,
      [providerId, externalTransactionId],
    );
  }

  public findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
    lock = false,
  ): Promise<WagerTransaction | null> {
    return this.findOne(
      `select ${TRANSACTION_COLUMNS}
         from wager_transactions
        where provider_id = ? and idempotency_key = ?${lock ? ' for update' : ''}`,
      [providerId, idempotencyKey],
    );
  }

  public findReversalByReference(
    referenceTransactionId: string,
    kind: 'REFUND' | 'ROLLBACK',
    excludingTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.findOne(
      `select ${TRANSACTION_COLUMNS}
         from wager_transactions
        where reference_transaction_id = ?
          and kind = ?
          and id <> ?
        order by created_at, id
        limit 1`,
      [referenceTransactionId, kind, excludingTransactionId],
    );
  }

  public async insert(transaction: WagerTransaction): Promise<boolean> {
    const state = transaction.toState();
    const rows = await queryRows<{ readonly id: string }>(
      this.entityManager,
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
          reference_external_transaction_id, reference_transaction_id, status,
          failure_code, observed_balance_minor, observed_balance_currency, retry_attempts, next_retry_at,
          retry_expires_at, processed_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        state.id,
        state.providerId,
        state.externalTransactionId,
        state.idempotencyKey,
        state.payloadHash,
        state.walletId,
        state.playerId,
        state.roundId,
        state.gameId,
        state.kind,
        state.amountMinor.toString(),
        state.currency,
        state.referenceExternalTransactionId,
        state.referenceTransactionId,
        state.status,
        state.failureCode,
        state.observedBalanceMinor?.toString() ?? null,
        state.observedBalanceCurrency,
        state.retryAttempts,
        state.nextRetryAt,
        state.retryExpiresAt,
        state.processedAt,
        state.createdAt,
        state.updatedAt,
      ],
    );

    return rows.length === 1;
  }

  public async save(transaction: WagerTransaction): Promise<void> {
    const state = transaction.toState();
    await executeStatement(
      this.entityManager,
      `update wager_transactions
          set reference_transaction_id = ?, status = ?, failure_code = ?,
              observed_balance_minor = ?, observed_balance_currency = ?,
              retry_attempts = ?, next_retry_at = ?, retry_expires_at = ?,
              pending_lease_token = case when ? = 'PENDING_REFERENCE' then pending_lease_token else null end,
              pending_lease_expires_at = case when ? = 'PENDING_REFERENCE' then pending_lease_expires_at else null end,
              processed_at = ?, updated_at = ?
        where id = ?`,
      [
        state.referenceTransactionId,
        state.status,
        state.failureCode,
        state.observedBalanceMinor?.toString() ?? null,
        state.observedBalanceCurrency,
        state.retryAttempts,
        state.nextRetryAt,
        state.retryExpiresAt,
        state.status,
        state.status,
        state.processedAt,
        state.updatedAt,
        state.id,
      ],
    );
  }

  private async findOne(
    sql: string,
    parameters: readonly unknown[],
  ): Promise<WagerTransaction | null> {
    const rows = await queryRows<WagerTransactionDatabaseRow>(this.entityManager, sql, parameters);
    const row = rows[0];
    return row === undefined ? null : WagerTransactionMapper.toDomain(row);
  }
}
