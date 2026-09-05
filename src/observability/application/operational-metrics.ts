import type { WalletLockMetrics } from '../../wallet/application/ports/wallet-lock-metrics.js';

export type TransactionMetricStatus = 'FAILED' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED';
export type TransactionMetricKind = 'BET' | 'LOSS' | 'REFUND' | 'ROLLBACK' | 'WIN';
export type DuplicateMetricSource = 'http' | 'sqs_command';
export type RetryMetricComponent = 'outbox' | 'pending_reference' | 'sqs_command';
export type DeadLetterMetricReason = 'malformed_envelope' | 'permanent_transport';
export type ProcessingMetricTransport = 'http' | 'sqs';

export interface OperationalMetrics {
  readonly walletLockMetrics: WalletLockMetrics;
  recordTransaction(
    status: TransactionMetricStatus,
    kind: TransactionMetricKind,
    transport: ProcessingMetricTransport,
  ): void;
  recordDuplicate(source: DuplicateMetricSource): void;
  recordRetry(component: RetryMetricComponent): void;
  recordDeadLetter(reason: DeadLetterMetricReason): void;
  recordLockConflict(): void;
  observeOutboxLag(durationSeconds: number): void;
  observeProcessingDuration(durationSeconds: number, transport: ProcessingMetricTransport): void;
  recordReconciliationDivergence(): void;
  recordInbox(outcome: 'completed' | 'duplicate' | 'conflict' | 'retryable'): void;
  recordOutboxPublication(outcome: 'published' | 'rescheduled' | 'skipped'): void;
  recordFailpoint(name: string): void;
}

const NOOP_WALLET_LOCK_METRICS: WalletLockMetrics = Object.freeze({
  observeWait: () => undefined,
});

export const NOOP_OPERATIONAL_METRICS: OperationalMetrics = Object.freeze({
  walletLockMetrics: NOOP_WALLET_LOCK_METRICS,
  recordTransaction: () => undefined,
  recordDuplicate: () => undefined,
  recordRetry: () => undefined,
  recordDeadLetter: () => undefined,
  recordLockConflict: () => undefined,
  observeOutboxLag: () => undefined,
  observeProcessingDuration: () => undefined,
  recordReconciliationDivergence: () => undefined,
  recordInbox: () => undefined,
  recordOutboxPublication: () => undefined,
  recordFailpoint: () => undefined,
});
