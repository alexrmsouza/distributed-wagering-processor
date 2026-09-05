import { randomUUID } from 'node:crypto';

import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import type { OperationalLogger } from '../../observability/application/operational-logger.js';
import { NOOP_OPERATIONAL_LOGGER } from '../../observability/application/operational-logger.js';
import type { OperationalMetrics } from '../../observability/application/operational-metrics.js';
import { NOOP_OPERATIONAL_METRICS } from '../../observability/application/operational-metrics.js';
import { SystemClock, type Clock } from '../../shared/application/clock.js';
import { createCorrelationContext } from '../../shared/application/correlation-context.js';
import type { TransactionRunner } from '../../shared/application/transaction-runner.js';
import type { FailpointPort } from '../../shared/infrastructure/failpoints/failpoint.port.js';
import type { OutboxRepository } from '../application/outbox.repository.js';
import type { OutboxMessage } from '../domain/outbox-message.js';
import type { IntegrationEventPublisher } from './integration-event.publisher.js';

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_PERIOD_MS = 10_000;

export interface OutboxTransactionContext {
  readonly outbox: OutboxRepository;
}

export interface OutboxWorkerOptions {
  readonly enabled?: boolean;
  readonly clock?: Clock;
  readonly generateLeaseToken?: () => string;
  readonly batchSize?: number;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly shutdownGracePeriodMs?: number;
  readonly failpoints?: FailpointPort;
  readonly onError?: (error: unknown) => void;
  readonly logger?: OperationalLogger;
  readonly metrics?: OperationalMetrics;
}

export interface OutboxWorkerRunResult {
  readonly claimed: number;
  readonly published: number;
  readonly rescheduled: number;
  readonly skipped: number;
}

export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  readonly #enabled: boolean;
  readonly #clock: Clock;
  readonly #generateLeaseToken: () => string;
  readonly #batchSize: number;
  readonly #leaseDurationMs: number;
  readonly #pollIntervalMs: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #shutdownGracePeriodMs: number;
  readonly #failpoints: FailpointPort | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #logger: OperationalLogger;
  readonly #metrics: OperationalMetrics;
  #stopping = false;
  #polling: Promise<void> | null = null;
  #wakePoll: (() => void) | null = null;

  public constructor(
    private readonly transactionRunner: TransactionRunner<OutboxTransactionContext>,
    private readonly publisher: IntegrationEventPublisher,
    options: OutboxWorkerOptions = {},
  ) {
    this.#enabled = options.enabled ?? true;
    this.#clock = options.clock ?? new SystemClock();
    this.#generateLeaseToken = options.generateLeaseToken ?? randomUUID;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.#retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.#shutdownGracePeriodMs = options.shutdownGracePeriodMs ?? DEFAULT_SHUTDOWN_GRACE_PERIOD_MS;
    this.#failpoints = options.failpoints;
    this.#onError = options.onError ?? (() => undefined);
    this.#logger = options.logger ?? NOOP_OPERATIONAL_LOGGER;
    this.#metrics = options.metrics ?? NOOP_OPERATIONAL_METRICS;
    this.assertOptions();
  }

  public onModuleInit(): void {
    if (this.#enabled && this.#polling === null) {
      this.#stopping = false;
      this.#polling = this.poll();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    this.#stopping = true;
    this.#wakePoll?.();
    const polling = this.#polling;
    if (polling !== null) {
      await Promise.race([polling, Bun.sleep(this.#shutdownGracePeriodMs)]);
    }
    this.#polling = null;
  }

  public async runOnce(): Promise<OutboxWorkerRunResult> {
    if (this.#stopping) {
      return Object.freeze({ claimed: 0, published: 0, rescheduled: 0, skipped: 0 });
    }

    const now = this.now();
    const leaseToken = this.#generateLeaseToken();
    const leaseExpiresAt = new Date(now.getTime() + this.#leaseDurationMs);
    const messages = await this.transactionRunner.run(({ outbox }) =>
      outbox.claimDue({ now, leaseToken, leaseExpiresAt, limit: this.#batchSize }),
    );
    const counts = { claimed: messages.length, published: 0, rescheduled: 0, skipped: 0 };

    for (const message of messages) {
      this.safeLog('outbox_claimed', message);
    }

    if (messages.length > 0) {
      await this.#failpoints?.trigger('after_outbox_claim_before_publish');
    }

    for (const message of messages) {
      if (this.isStopping()) {
        counts.skipped += 1;
        continue;
      }
      await this.publishClaimed(message, leaseToken, counts);
    }

    return Object.freeze(counts);
  }

  private async publishClaimed(
    message: OutboxMessage,
    leaseToken: string,
    counts: { published: number; rescheduled: number; skipped: number },
  ): Promise<void> {
    try {
      await this.publisher.publish(message);
    } catch (error: unknown) {
      const state = message.toState();
      const attempts = state.attempts + 1;
      const retryAt = new Date(this.now().getTime() + this.retryDelayMs(attempts));
      const rescheduled = await this.transactionRunner.run(({ outbox }) =>
        outbox.reschedule(message.id, leaseToken, attempts, retryAt),
      );
      if (rescheduled) {
        counts.rescheduled += 1;
        this.safeMetric(() => {
          this.#metrics.recordRetry('outbox');
        });
        this.safeMetric(() => {
          this.#metrics.recordOutboxPublication('rescheduled');
        });
      } else {
        counts.skipped += 1;
        this.safeMetric(() => {
          this.#metrics.recordOutboxPublication('skipped');
        });
      }
      this.#onError(error);
      return;
    }

    await this.#failpoints?.trigger('after_sqs_publish_before_outbox_mark_published');
    const publishedAt = this.now();
    const marked = await this.transactionRunner.run(({ outbox }) =>
      outbox.markPublished(message.id, leaseToken, publishedAt),
    );
    if (marked) {
      counts.published += 1;
      this.safeLog('published', message);
      this.safeMetric(() => {
        this.#metrics.recordOutboxPublication('published');
      });
      this.safeMetric(() => {
        this.#metrics.observeOutboxLag(
          Math.max(0, (publishedAt.getTime() - message.toState().occurredAt.getTime()) / 1_000),
        );
      });
    } else {
      counts.skipped += 1;
      this.safeMetric(() => {
        this.#metrics.recordOutboxPublication('skipped');
      });
    }
  }

  private retryDelayMs(attempts: number): number {
    const exponent = Math.min(attempts - 1, 30);
    return Math.min(this.#retryBaseDelayMs * 2 ** exponent, this.#retryMaxDelayMs);
  }

  private now(): Date {
    const now = this.#clock.now();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError('Outbox worker clock returned an invalid instant');
    }
    return new Date(now);
  }

  private async poll(): Promise<void> {
    while (!this.#stopping) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        this.#onError(error);
      }
      if (!this.isStopping()) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, this.#pollIntervalMs);
          this.#wakePoll = () => {
            clearTimeout(timeout);
            resolve();
          };
        });
        this.#wakePoll = null;
      }
    }
  }

  private isStopping(): boolean {
    return this.#stopping;
  }

  private assertOptions(): void {
    const positiveSafeIntegers = [
      this.#batchSize,
      this.#leaseDurationMs,
      this.#pollIntervalMs,
      this.#retryBaseDelayMs,
      this.#retryMaxDelayMs,
    ];
    if (positiveSafeIntegers.some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError('Outbox worker limits must be positive safe integers');
    }
    if (
      !Number.isSafeInteger(this.#shutdownGracePeriodMs) ||
      this.#shutdownGracePeriodMs < 0 ||
      this.#retryMaxDelayMs < this.#retryBaseDelayMs
    ) {
      throw new TypeError('Outbox worker retry and shutdown limits are invalid');
    }
  }

  private safeLog(event: 'outbox_claimed' | 'published', message: OutboxMessage): void {
    const state = message.toState();
    const envelope = state.payload as Readonly<{
      eventId?: unknown;
      data?: Readonly<{ providerId?: unknown }>;
    }>;
    const providerId =
      typeof envelope.data?.providerId === 'string' ? envelope.data.providerId : undefined;
    const eventId = typeof envelope.eventId === 'string' ? envelope.eventId : state.eventId;
    try {
      this.#logger.info(
        event,
        createCorrelationContext({
          correlationId: state.correlationId,
          walletId: state.aggregateId,
          outboxMessageId: state.id,
          eventId,
          ...(providerId === undefined ? {} : { providerId }),
          ...(state.causationId === null ? {} : { causationId: state.causationId }),
        }),
      );
    } catch {
      // Diagnostics must not change publication behavior.
    }
  }

  private safeMetric(record: () => void): void {
    try {
      record();
    } catch {
      // Metrics must not change publication behavior.
    }
  }
}
