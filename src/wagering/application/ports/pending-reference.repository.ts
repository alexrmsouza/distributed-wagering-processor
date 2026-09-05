import type { TransactionBoundRepository } from '../../../shared/application/transaction-runner.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';

export interface PendingReferenceLease {
  readonly transaction: WagerTransaction;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface PendingReferenceContext {
  readonly transaction: WagerTransaction;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface PendingReferenceSchedule {
  readonly retryAttempts: number;
  readonly nextRetryAt: Date;
  readonly retryExpiresAt: Date;
}

export interface PendingReferenceRepository extends TransactionBoundRepository {
  initialize(
    transaction: WagerTransaction,
    schedule: PendingReferenceSchedule,
    correlationId: string,
    causationId: string | null,
    updatedAt: Date,
  ): Promise<void>;
  claimDue(options: {
    readonly now: Date;
    readonly leaseToken: string;
    readonly leaseExpiresAt: Date;
    readonly limit: number;
  }): Promise<readonly PendingReferenceLease[]>;
  lockPending(transactionId: string): Promise<PendingReferenceContext | null>;
  lockLeased(
    transactionId: string,
    leaseToken: string,
    now: Date,
  ): Promise<PendingReferenceContext | null>;
  reschedule(
    transaction: WagerTransaction,
    leaseToken: string | null,
    schedule: PendingReferenceSchedule,
    updatedAt: Date,
  ): Promise<void>;
  clearLease(transactionId: string, leaseToken: string | null): Promise<void>;
}
