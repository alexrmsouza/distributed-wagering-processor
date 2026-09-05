import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionState,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction.js';
import type { FailureCode } from '../../domain/failure-code.js';

export interface WagerTransactionDatabaseRow {
  readonly id: string;
  readonly provider_id: string;
  readonly external_transaction_id: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly wallet_id: string;
  readonly player_id: string;
  readonly round_id: string;
  readonly game_id: string;
  readonly kind: WagerTransactionKind;
  readonly amount_minor: string | bigint;
  readonly currency: string;
  readonly reference_external_transaction_id: string | null;
  readonly reference_transaction_id: string | null;
  readonly status: WagerTransactionStatus;
  readonly failure_code: FailureCode | null;
  readonly observed_balance_minor: string | bigint | null;
  readonly observed_balance_currency: string | null;
  readonly retry_attempts: number;
  readonly next_retry_at: Date | null;
  readonly retry_expires_at: Date | null;
  readonly processed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export const WagerTransactionMapper = {
  toState(row: WagerTransactionDatabaseRow): WagerTransactionState {
    return Object.freeze({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash.trim(),
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      amountMinor: BigInt(row.amount_minor),
      currency: row.currency.trim(),
      referenceExternalTransactionId: row.reference_external_transaction_id,
      referenceTransactionId: row.reference_transaction_id,
      status: row.status,
      failureCode: row.failure_code,
      observedBalanceMinor:
        row.observed_balance_minor === null ? null : BigInt(row.observed_balance_minor),
      observedBalanceCurrency: row.observed_balance_currency?.trim() ?? null,
      retryAttempts: row.retry_attempts,
      nextRetryAt: row.next_retry_at === null ? null : new Date(row.next_retry_at),
      retryExpiresAt: row.retry_expires_at === null ? null : new Date(row.retry_expires_at),
      processedAt: row.processed_at === null ? null : new Date(row.processed_at),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  },

  toDomain(row: WagerTransactionDatabaseRow): WagerTransaction {
    return WagerTransaction.rehydrate(WagerTransactionMapper.toState(row));
  },
};
