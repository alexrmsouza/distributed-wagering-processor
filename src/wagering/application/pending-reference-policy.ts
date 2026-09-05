import type { Clock } from '../../shared/application/clock.js';

const INITIAL_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const RETRY_TTL_MS = 24 * 60 * 60 * 1_000;
const FIRST_CAPPED_ATTEMPT = 7;

export interface PendingReferenceRetryState {
  readonly retryAttempts: number;
  readonly nextRetryAt: Date;
  readonly retryExpiresAt: Date;
}

export interface PendingReferenceRetryDecision extends PendingReferenceRetryState {
  readonly kind: 'RETRY';
}

export interface PendingReferenceExpiredDecision {
  readonly kind: 'EXPIRED';
  readonly retryAttempts: number;
  readonly retryExpiresAt: Date;
  readonly failureCode: 'REFERENCE_NOT_FOUND';
}

export type PendingReferenceDecision =
  PendingReferenceRetryDecision | PendingReferenceExpiredDecision;

export class PendingReferencePolicy {
  public constructor(private readonly clock: Clock) {}

  public accept(): PendingReferenceRetryState {
    const acceptedAt = this.now();

    return Object.freeze({
      retryAttempts: 0,
      nextRetryAt: new Date(acceptedAt.getTime() + INITIAL_RETRY_DELAY_MS),
      retryExpiresAt: new Date(acceptedAt.getTime() + RETRY_TTL_MS),
    });
  }

  public afterMissingReference(state: PendingReferenceRetryState): PendingReferenceDecision {
    PendingReferencePolicy.assertState(state);
    const now = this.now();
    const retryExpiresAt = new Date(state.retryExpiresAt);

    if (now.getTime() >= retryExpiresAt.getTime()) {
      return Object.freeze({
        kind: 'EXPIRED',
        retryAttempts: state.retryAttempts,
        retryExpiresAt,
        failureCode: 'REFERENCE_NOT_FOUND',
      });
    }

    const retryAttempts = state.retryAttempts + 1;
    const candidateRetryAt = now.getTime() + PendingReferencePolicy.delayFor(retryAttempts);
    const nextRetryAt = new Date(Math.min(candidateRetryAt, retryExpiresAt.getTime()));

    return Object.freeze({
      kind: 'RETRY',
      retryAttempts,
      nextRetryAt,
      retryExpiresAt,
    });
  }

  private static delayFor(attempt: number): number {
    if (attempt >= FIRST_CAPPED_ATTEMPT) {
      return MAX_RETRY_DELAY_MS;
    }

    return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
  }

  private static assertState(state: PendingReferenceRetryState): void {
    if (
      !Number.isSafeInteger(state.retryAttempts) ||
      state.retryAttempts < 0 ||
      state.retryAttempts === Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(state.nextRetryAt.getTime()) ||
      !Number.isFinite(state.retryExpiresAt.getTime())
    ) {
      throw new TypeError('Pending reference retry state is invalid');
    }
  }

  private now(): Date {
    const now = this.clock.now();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError('Pending reference clock returned an invalid instant');
    }

    return new Date(now);
  }
}
