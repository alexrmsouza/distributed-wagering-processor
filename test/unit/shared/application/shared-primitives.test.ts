import { describe, expect, test } from 'bun:test';

import { SystemClock, type Clock } from '../../../../src/shared/application/clock.js';
import { createCorrelationContext } from '../../../../src/shared/application/correlation-context.js';

describe('clock primitives', () => {
  test('allows deterministic clocks to be injected', () => {
    const instant = new Date('2026-09-04T10:30:00.000Z');
    const fixedClock: Clock = { now: () => instant };

    expect(fixedClock.now()).toBe(instant);
  });

  test('returns the current time from the system clock', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const observed = clock.now().getTime();
    const after = Date.now();

    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });
});

describe('correlation context', () => {
  test('retains only known diagnostic identifiers', () => {
    const untrustedInput = {
      correlationId: 'correlation-1',
      messageId: 'message-1',
      transactionId: 'transaction-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
      outboxMessageId: 'outbox-1',
      rawPayload: { amount: '100.00' },
      authorization: 'secret',
    };

    const context = createCorrelationContext(untrustedInput);

    expect(context).toEqual({
      correlationId: 'correlation-1',
      messageId: 'message-1',
      transactionId: 'transaction-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
      outboxMessageId: 'outbox-1',
    });
  });

  test('returns an immutable context', () => {
    const context = createCorrelationContext({ correlationId: 'correlation-1' });

    expect(Object.isFrozen(context)).toBe(true);
  });
});
