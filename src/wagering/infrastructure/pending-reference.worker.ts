import { randomUUID } from 'node:crypto';

import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import type { OperationalMetrics } from '../../observability/application/operational-metrics.js';
import { NOOP_OPERATIONAL_METRICS } from '../../observability/application/operational-metrics.js';
import { SystemClock, type Clock } from '../../shared/application/clock.js';
import type { TransactionRunner } from '../../shared/application/transaction-runner.js';
import type { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.use-case.js';
import type { WageringTransactionContext } from '../application/ports/wagering-transaction-context.js';

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface PendingReferenceWorkerOptions {
  readonly clock?: Clock;
  readonly generateLeaseToken?: () => string;
  readonly batchSize?: number;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly metrics?: OperationalMetrics;
}

export interface PendingReferenceWorkerRunResult {
  readonly claimed: number;
  readonly processed: number;
  readonly rejected: number;
  readonly rescheduled: number;
  readonly skipped: number;
}

export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  readonly #clock: Clock;
  readonly #generateLeaseToken: () => string;
  readonly #batchSize: number;
  readonly #leaseDurationMs: number;
  readonly #pollIntervalMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #metrics: OperationalMetrics;
  #stopping = false;
  #polling: Promise<void> | null = null;

  public constructor(
    private readonly transactionRunner: TransactionRunner<WageringTransactionContext>,
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    options: PendingReferenceWorkerOptions = {},
  ) {
    this.#clock = options.clock ?? new SystemClock();
    this.#generateLeaseToken = options.generateLeaseToken ?? randomUUID;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#onError = options.onError ?? (() => undefined);
    this.#metrics = options.metrics ?? NOOP_OPERATIONAL_METRICS;
    if (
      !Number.isSafeInteger(this.#batchSize) ||
      this.#batchSize < 1 ||
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs < 1 ||
      !Number.isSafeInteger(this.#pollIntervalMs) ||
      this.#pollIntervalMs < 1
    ) {
      throw new TypeError('Pending reference worker limits must be positive safe integers');
    }
  }

  public onModuleInit(): void {
    if (this.#polling === null) {
      this.#stopping = false;
      this.#polling = this.poll();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    this.#stopping = true;
    await this.#polling;
    this.#polling = null;
  }

  public async runOnce(): Promise<PendingReferenceWorkerRunResult> {
    const now = this.now();
    const leaseToken = this.#generateLeaseToken();
    const leaseExpiresAt = new Date(now.getTime() + this.#leaseDurationMs);
    const claims = await this.transactionRunner.run(({ pendingReferences }) =>
      pendingReferences.claimDue({
        now,
        leaseToken,
        leaseExpiresAt,
        limit: this.#batchSize,
      }),
    );
    const counts = {
      claimed: claims.length,
      processed: 0,
      rejected: 0,
      rescheduled: 0,
      skipped: 0,
    };

    for (const claim of claims) {
      const result = await this.processWagerTransaction.retryPendingReference(
        claim.transaction.id,
        claim.leaseToken,
      );
      if (result === null) {
        counts.skipped += 1;
      } else if (result.status === 'PROCESSED') {
        counts.processed += 1;
      } else if (result.status === 'REJECTED') {
        counts.rejected += 1;
      } else if (result.status === 'PENDING_REFERENCE') {
        counts.rescheduled += 1;
        this.safeMetric(() => {
          this.#metrics.recordRetry('pending_reference');
        });
      } else {
        counts.skipped += 1;
      }
    }

    return Object.freeze(counts);
  }

  private now(): Date {
    const now = this.#clock.now();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError('Pending reference worker clock returned an invalid instant');
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
      await Bun.sleep(this.#pollIntervalMs);
    }
  }

  private safeMetric(record: () => void): void {
    try {
      record();
    } catch {
      // Metrics must not change pending-reference processing.
    }
  }
}
