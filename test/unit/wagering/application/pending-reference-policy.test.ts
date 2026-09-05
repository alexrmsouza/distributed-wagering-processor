import { describe, expect, test } from 'bun:test';

import type { Clock } from '../../../../src/shared/application/clock.js';

const ACCEPTED_AT = new Date('2026-09-04T12:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-05T12:00:00.000Z');

class MutableClock implements Clock {
  public constructor(private current: Date) {}

  public now(): Date {
    return new Date(this.current);
  }

  public set(instant: Date): void {
    this.current = new Date(instant);
  }
}

async function loadPolicy() {
  return import('../../../../src/wagering/application/pending-reference-policy.js');
}

describe('PendingReferencePolicy', () => {
  test('starts a fixed 24-hour lifetime with retry attempt zero due after 30 seconds', async () => {
    const { PendingReferencePolicy } = await loadPolicy();
    const clock = new MutableClock(ACCEPTED_AT);
    const policy = new PendingReferencePolicy(clock);

    const schedule = policy.accept();

    expect(schedule).toEqual({
      retryAttempts: 0,
      nextRetryAt: new Date('2026-09-04T12:00:30.000Z'),
      retryExpiresAt: EXPIRES_AT,
    });
  });

  test('applies deterministic exponential backoff from the persisted attempt index', async () => {
    const { PendingReferencePolicy } = await loadPolicy();
    const clock = new MutableClock(new Date('2026-09-04T12:00:30.000Z'));
    const policy = new PendingReferencePolicy(clock);

    const firstReschedule = policy.afterMissingReference({
      retryAttempts: 0,
      nextRetryAt: clock.now(),
      retryExpiresAt: EXPIRES_AT,
    });

    expect(firstReschedule).toEqual({
      kind: 'RETRY',
      retryAttempts: 1,
      nextRetryAt: new Date('2026-09-04T12:01:30.000Z'),
      retryExpiresAt: EXPIRES_AT,
    });

    clock.set(new Date('2026-09-04T12:01:30.000Z'));
    const secondReschedule = policy.afterMissingReference({
      retryAttempts: 1,
      nextRetryAt: clock.now(),
      retryExpiresAt: EXPIRES_AT,
    });

    expect(secondReschedule).toEqual({
      kind: 'RETRY',
      retryAttempts: 2,
      nextRetryAt: new Date('2026-09-04T12:03:30.000Z'),
      retryExpiresAt: EXPIRES_AT,
    });
  });

  test('caps backoff at one hour without overflowing for a large persisted attempt count', async () => {
    const { PendingReferencePolicy } = await loadPolicy();
    const now = new Date('2026-09-04T13:00:00.000Z');
    const policy = new PendingReferencePolicy(new MutableClock(now));

    const decision = policy.afterMissingReference({
      retryAttempts: 100,
      nextRetryAt: now,
      retryExpiresAt: EXPIRES_AT,
    });

    expect(decision).toEqual({
      kind: 'RETRY',
      retryAttempts: 101,
      nextRetryAt: new Date('2026-09-04T14:00:00.000Z'),
      retryExpiresAt: EXPIRES_AT,
    });
  });

  test('preserves persisted expiration instead of restarting the 24-hour lifetime', async () => {
    const { PendingReferencePolicy } = await loadPolicy();
    const acceptancePolicy = new PendingReferencePolicy(new MutableClock(ACCEPTED_AT));
    const persisted = acceptancePolicy.accept();
    const resumedAt = new Date('2026-09-05T11:00:00.000Z');
    const resumedPolicy = new PendingReferencePolicy(new MutableClock(resumedAt));

    const decision = resumedPolicy.afterMissingReference({
      ...persisted,
      retryAttempts: 20,
      nextRetryAt: resumedAt,
    });

    expect(decision).toEqual({
      kind: 'RETRY',
      retryAttempts: 21,
      nextRetryAt: EXPIRES_AT,
      retryExpiresAt: EXPIRES_AT,
    });
  });

  test('clamps the next wake-up to expiration and never schedules beyond the TTL', async () => {
    const { PendingReferencePolicy } = await loadPolicy();
    const justBeforeExpiration = new Date(EXPIRES_AT.getTime() - 1);
    const policy = new PendingReferencePolicy(new MutableClock(justBeforeExpiration));

    const decision = policy.afterMissingReference({
      retryAttempts: 20,
      nextRetryAt: justBeforeExpiration,
      retryExpiresAt: EXPIRES_AT,
    });

    expect(decision).toEqual({
      kind: 'RETRY',
      retryAttempts: 21,
      nextRetryAt: EXPIRES_AT,
      retryExpiresAt: EXPIRES_AT,
    });
  });

  test('expires exactly at the inclusive TTL boundary with a stable failure code', async () => {
    const { PendingReferencePolicy } = await loadPolicy();
    const policy = new PendingReferencePolicy(new MutableClock(EXPIRES_AT));

    const decision = policy.afterMissingReference({
      retryAttempts: 20,
      nextRetryAt: EXPIRES_AT,
      retryExpiresAt: EXPIRES_AT,
    });

    expect(decision).toEqual({
      kind: 'EXPIRED',
      retryAttempts: 20,
      retryExpiresAt: EXPIRES_AT,
      failureCode: 'REFERENCE_NOT_FOUND',
    });
  });
});
