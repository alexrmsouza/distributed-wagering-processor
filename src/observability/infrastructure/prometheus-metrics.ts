import { Counter, Gauge, Histogram, register, type Registry } from 'prom-client';

import type {
  DeadLetterMetricReason,
  DuplicateMetricSource,
  OperationalMetrics,
  ProcessingMetricTransport,
  QueueDepthMetricQueue,
  QueueDepthMetricState,
  RetryMetricComponent,
  TransactionMetricKind,
  TransactionMetricStatus,
} from '../application/operational-metrics.js';
import { PrometheusWalletLockMetrics } from '../../wallet/infrastructure/persistence/wallet-lock.metrics.js';

function requiredMetric<TMetric>(registry: Registry, name: string, create: () => TMetric): TMetric {
  return (registry.getSingleMetric(name) as TMetric | undefined) ?? create();
}

function assertMember<TValue extends string>(
  value: TValue,
  allowed: readonly TValue[],
  fieldName: string,
): void {
  if (!allowed.includes(value)) {
    throw new TypeError(`${fieldName} metric label is invalid`);
  }
}

function assertDuration(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a non-negative finite number`);
  }
}

export class PrometheusMetrics implements OperationalMetrics {
  public readonly walletLockMetrics: PrometheusWalletLockMetrics;
  public readonly registry: Registry;
  readonly #transactions: Counter<'kind' | 'status' | 'transport'>;
  readonly #duplicates: Counter<'source'>;
  readonly #retries: Counter<'component'>;
  readonly #deadLetters: Counter<'reason'>;
  readonly #lockConflicts: Counter;
  readonly #outboxLag: Histogram;
  readonly #processingDuration: Histogram<'transport'>;
  readonly #reconciliationDivergences: Counter;
  readonly #inboxProcessing: Counter<'outcome'>;
  readonly #outboxPublications: Counter<'outcome'>;
  readonly #failpoints: Counter<'name'>;
  readonly #queueDepth: Gauge<'queue' | 'state'>;
  readonly #queueDepthCollectionFailures: Counter<'queue'>;
  readonly #queueDepthLastSuccess: Gauge<'queue'>;

  public constructor(registry: Registry = register) {
    this.registry = registry;
    this.#transactions = requiredMetric(
      registry,
      'wager_transactions_total',
      () =>
        new Counter({
          name: 'wager_transactions_total',
          help: 'Committed Wager transaction outcomes',
          labelNames: ['status', 'kind', 'transport'],
          registers: [registry],
        }),
    );
    this.#duplicates = requiredMetric(
      registry,
      'wager_duplicates_total',
      () =>
        new Counter({
          name: 'wager_duplicates_total',
          help: 'Safely suppressed duplicate wagering requests',
          labelNames: ['source'],
          registers: [registry],
        }),
    );
    this.#retries = requiredMetric(
      registry,
      'wager_retries_total',
      () =>
        new Counter({
          name: 'wager_retries_total',
          help: 'Persisted worker retry attempts',
          labelNames: ['component'],
          registers: [registry],
        }),
    );
    this.#deadLetters = requiredMetric(
      registry,
      'wager_dlq_messages_total',
      () =>
        new Counter({
          name: 'wager_dlq_messages_total',
          help: 'Poison messages observed for native redrive',
          labelNames: ['reason'],
          registers: [registry],
        }),
    );
    this.#lockConflicts = requiredMetric(
      registry,
      'wallet_lock_conflicts_total',
      () =>
        new Counter({
          name: 'wallet_lock_conflicts_total',
          help: 'Wallet lock attempts that failed',
          registers: [registry],
        }),
    );
    this.#outboxLag = requiredMetric(
      registry,
      'outbox_lag_seconds',
      () =>
        new Histogram({
          name: 'outbox_lag_seconds',
          help: 'Age of an Outbox event when publication succeeds',
          buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
          registers: [registry],
        }),
    );
    this.#processingDuration = requiredMetric(
      registry,
      'wager_processing_duration_seconds',
      () =>
        new Histogram({
          name: 'wager_processing_duration_seconds',
          help: 'End-to-end wagering processing duration',
          labelNames: ['transport'],
          buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
          registers: [registry],
        }),
    );
    this.#reconciliationDivergences = requiredMetric(
      registry,
      'wallet_reconciliation_divergences_total',
      () =>
        new Counter({
          name: 'wallet_reconciliation_divergences_total',
          help: 'Wallet reconciliation checks that found a divergence',
          registers: [registry],
        }),
    );
    this.#inboxProcessing = requiredMetric(
      registry,
      'inbox_processing_total',
      () =>
        new Counter({
          name: 'inbox_processing_total',
          help: 'Durable Inbox processing outcomes',
          labelNames: ['outcome'],
          registers: [registry],
        }),
    );
    this.#outboxPublications = requiredMetric(
      registry,
      'outbox_publications_total',
      () =>
        new Counter({
          name: 'outbox_publications_total',
          help: 'Transactional Outbox publication outcomes',
          labelNames: ['outcome'],
          registers: [registry],
        }),
    );
    this.#failpoints = requiredMetric(
      registry,
      'failpoint_activations_total',
      () =>
        new Counter({
          name: 'failpoint_activations_total',
          help: 'Test-only failpoint activations',
          labelNames: ['name'],
          registers: [registry],
        }),
    );
    this.#queueDepth = requiredMetric(
      registry,
      'sqs_queue_depth_messages',
      () =>
        new Gauge({
          name: 'sqs_queue_depth_messages',
          help: 'Approximate SQS queue depth by bounded queue and state',
          labelNames: ['queue', 'state'],
          registers: [registry],
        }),
    );
    this.#queueDepthCollectionFailures = requiredMetric(
      registry,
      'sqs_queue_depth_collection_failures_total',
      () =>
        new Counter({
          name: 'sqs_queue_depth_collection_failures_total',
          help: 'Failed SQS queue depth collection attempts',
          labelNames: ['queue'],
          registers: [registry],
        }),
    );
    this.#queueDepthLastSuccess = requiredMetric(
      registry,
      'sqs_queue_depth_last_success_unixtime_seconds',
      () =>
        new Gauge({
          name: 'sqs_queue_depth_last_success_unixtime_seconds',
          help: 'Unix timestamp of the last successful SQS queue depth collection',
          labelNames: ['queue'],
          registers: [registry],
        }),
    );
    this.walletLockMetrics = new PrometheusWalletLockMetrics(registry, () => {
      this.recordLockConflict();
    });
  }

  public recordTransaction(
    status: TransactionMetricStatus,
    kind: TransactionMetricKind,
    transport: ProcessingMetricTransport,
  ): void {
    assertMember(status, ['FAILED', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED'], 'status');
    assertMember(kind, ['BET', 'LOSS', 'REFUND', 'ROLLBACK', 'WIN'], 'kind');
    assertMember(transport, ['http', 'sqs'], 'transport');
    this.#transactions.inc({ status, kind, transport });
  }

  public recordDuplicate(source: DuplicateMetricSource): void {
    assertMember(source, ['http', 'sqs_command'], 'source');
    this.#duplicates.inc({ source });
  }

  public recordRetry(component: RetryMetricComponent): void {
    assertMember(component, ['outbox', 'pending_reference', 'sqs_command'], 'component');
    this.#retries.inc({ component });
  }

  public recordDeadLetter(reason: DeadLetterMetricReason): void {
    assertMember(reason, ['malformed_envelope', 'permanent_transport'], 'reason');
    this.#deadLetters.inc({ reason });
  }

  public recordLockConflict(): void {
    this.#lockConflicts.inc();
  }

  public observeOutboxLag(durationSeconds: number): void {
    assertDuration(durationSeconds, 'Outbox lag');
    this.#outboxLag.observe(durationSeconds);
  }

  public observeProcessingDuration(
    durationSeconds: number,
    transport: ProcessingMetricTransport,
  ): void {
    assertDuration(durationSeconds, 'Processing duration');
    assertMember(transport, ['http', 'sqs'], 'transport');
    this.#processingDuration.observe({ transport }, durationSeconds);
  }

  public recordReconciliationDivergence(): void {
    this.#reconciliationDivergences.inc();
  }

  public recordInbox(outcome: 'completed' | 'duplicate' | 'conflict' | 'retryable'): void {
    assertMember(outcome, ['completed', 'duplicate', 'conflict', 'retryable'], 'outcome');
    this.#inboxProcessing.inc({ outcome });
  }

  public recordOutboxPublication(
    outcome: 'blocked' | 'published' | 'rescheduled' | 'skipped',
  ): void {
    assertMember(outcome, ['blocked', 'published', 'rescheduled', 'skipped'], 'outcome');
    this.#outboxPublications.inc({ outcome });
  }

  public recordFailpoint(name: string): void {
    assertMember(
      name,
      [
        'before_financial_commit',
        'after_financial_commit_before_sqs_ack',
        'after_outbox_claim_before_publish',
        'after_sqs_publish_before_outbox_mark_published',
      ],
      'name',
    );
    this.#failpoints.inc({ name });
  }

  public setQueueDepth(
    queue: QueueDepthMetricQueue,
    state: QueueDepthMetricState,
    value: number,
  ): void {
    assertMember(queue, ['command', 'command_dlq', 'event'], 'queue');
    assertMember(state, ['available', 'delayed', 'in_flight'], 'state');
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('Queue depth must be a non-negative safe integer');
    }
    this.#queueDepth.set({ queue, state }, value);
  }

  public recordQueueDepthCollectionFailure(queue: QueueDepthMetricQueue): void {
    assertMember(queue, ['command', 'command_dlq', 'event'], 'queue');
    this.#queueDepthCollectionFailures.inc({ queue });
  }

  public setQueueDepthLastSuccess(queue: QueueDepthMetricQueue, timestampSeconds: number): void {
    assertMember(queue, ['command', 'command_dlq', 'event'], 'queue');
    if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
      throw new RangeError('Queue depth success timestamp must be a non-negative safe integer');
    }
    this.#queueDepthLastSuccess.set({ queue }, timestampSeconds);
  }
}

let defaultMetrics: PrometheusMetrics | undefined;

export function getDefaultPrometheusMetrics(): PrometheusMetrics {
  defaultMetrics ??= new PrometheusMetrics(register);
  return defaultMetrics;
}
