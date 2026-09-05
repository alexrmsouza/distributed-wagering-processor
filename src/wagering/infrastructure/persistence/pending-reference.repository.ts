import type { EntityManager } from '@mikro-orm/core';

import { queryRows } from '../../../shared/infrastructure/persistence/transactional-query.js';
import type {
  PendingReferenceLease,
  PendingReferenceRepository,
  PendingReferenceSchedule,
} from '../../application/ports/pending-reference.repository.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import {
  WagerTransactionMapper,
  type WagerTransactionDatabaseRow,
} from './wager-transaction.mapper.js';

const TRANSACTION_COLUMNS = `
  id, provider_id, external_transaction_id, idempotency_key, payload_hash,
  wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
  reference_external_transaction_id, reference_transaction_id, status,
  failure_code, observed_balance_minor, observed_balance_currency, retry_attempts,
  next_retry_at, retry_expires_at, processed_at, created_at, updated_at
`;
const RETURNING_TRANSACTION_COLUMNS = TRANSACTION_COLUMNS.replace(
  /\b([a-z][a-z_]*)\b/g,
  'transaction.$1',
);

interface ClaimedPendingReferenceRow extends WagerTransactionDatabaseRow {
  readonly pending_lease_token: string;
  readonly pending_lease_expires_at: Date;
  readonly pending_correlation_id: string;
  readonly pending_causation_id: string | null;
}

export class MikroOrmPendingReferenceRepository implements PendingReferenceRepository {
  public readonly transactionBound = true as const;

  public constructor(private readonly entityManager: EntityManager) {}

  public async initialize(
    transaction: WagerTransaction,
    schedule: PendingReferenceSchedule,
    correlationId: string,
    causationId: string | null,
    updatedAt: Date,
  ): Promise<void> {
    const rows = await queryRows<{ readonly id: string }>(
      this.entityManager,
      `update wager_transactions
          set status = 'PENDING_REFERENCE', retry_attempts = ?, next_retry_at = ?,
              retry_expires_at = ?, pending_correlation_id = ?, pending_causation_id = ?,
              updated_at = ?
        where id = ? and status = 'PENDING'
       returning id`,
      [
        schedule.retryAttempts,
        schedule.nextRetryAt,
        schedule.retryExpiresAt,
        correlationId,
        causationId,
        updatedAt,
        transaction.id,
      ],
    );
    if (rows.length !== 1) {
      throw new Error('Pending reference could not be initialized');
    }
  }

  public async claimDue(options: {
    readonly now: Date;
    readonly leaseToken: string;
    readonly leaseExpiresAt: Date;
    readonly limit: number;
  }): Promise<readonly PendingReferenceLease[]> {
    const rows = await queryRows<ClaimedPendingReferenceRow>(
      this.entityManager,
      `with due as (
         select id
           from wager_transactions
          where status = 'PENDING_REFERENCE'
            and next_retry_at <= ?
            and (pending_lease_expires_at is null or pending_lease_expires_at <= ?)
          order by next_retry_at, id
          for update skip locked
          limit ?
       )
       update wager_transactions transaction
          set pending_lease_token = ?::uuid,
              pending_lease_expires_at = ?,
              updated_at = greatest(transaction.updated_at, ?)
         from due
        where transaction.id = due.id
       returning ${RETURNING_TRANSACTION_COLUMNS}, transaction.pending_lease_token,
                 transaction.pending_lease_expires_at, transaction.pending_correlation_id,
                 transaction.pending_causation_id`,
      [
        options.now,
        options.now,
        options.limit,
        options.leaseToken,
        options.leaseExpiresAt,
        options.now,
      ],
    );

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          transaction: WagerTransactionMapper.toDomain(row),
          leaseToken: row.pending_lease_token,
          leaseExpiresAt: new Date(row.pending_lease_expires_at),
          correlationId: row.pending_correlation_id,
          causationId: row.pending_causation_id,
        }),
      ),
    );
  }

  public async lockPending(transactionId: string) {
    return this.findLocked(`id = ? and status = 'PENDING_REFERENCE'`, [transactionId]);
  }

  public async lockLeased(transactionId: string, leaseToken: string, now: Date) {
    return this.findLocked(
      `id = ? and status = 'PENDING_REFERENCE'
       and pending_lease_token = ?::uuid and pending_lease_expires_at > ?`,
      [transactionId, leaseToken, now],
    );
  }

  public async reschedule(
    transaction: WagerTransaction,
    leaseToken: string | null,
    schedule: PendingReferenceSchedule,
    updatedAt: Date,
  ): Promise<void> {
    const rows = await queryRows<{ readonly id: string }>(
      this.entityManager,
      `update wager_transactions
          set retry_attempts = ?, next_retry_at = ?, retry_expires_at = ?,
              pending_lease_token = null, pending_lease_expires_at = null, updated_at = ?
        where id = ?
          and status = 'PENDING_REFERENCE'
          and pending_lease_token is not distinct from ?::uuid
       returning id`,
      [
        schedule.retryAttempts,
        schedule.nextRetryAt,
        schedule.retryExpiresAt,
        updatedAt,
        transaction.id,
        leaseToken,
      ],
    );
    if (rows.length !== 1) {
      throw new Error('Pending reference retry lease is no longer active');
    }
  }

  public async clearLease(transactionId: string, leaseToken: string | null): Promise<void> {
    const rows = await queryRows<{ readonly id: string }>(
      this.entityManager,
      `update wager_transactions
          set pending_lease_token = null, pending_lease_expires_at = null
        where id = ? and pending_lease_token is not distinct from ?::uuid
       returning id`,
      [transactionId, leaseToken],
    );
    if (rows.length !== 1) {
      throw new Error('Pending reference retry lease is no longer active');
    }
  }

  private async findLocked(predicate: string, parameters: readonly unknown[]) {
    const rows = await queryRows<
      WagerTransactionDatabaseRow & {
        readonly pending_correlation_id: string;
        readonly pending_causation_id: string | null;
      }
    >(
      this.entityManager,
      `select ${TRANSACTION_COLUMNS}, pending_correlation_id, pending_causation_id
         from wager_transactions
        where ${predicate}
        for update`,
      parameters,
    );
    const row = rows[0];
    return row === undefined
      ? null
      : Object.freeze({
          transaction: WagerTransactionMapper.toDomain(row),
          correlationId: row.pending_correlation_id,
          causationId: row.pending_causation_id,
        });
  }
}
