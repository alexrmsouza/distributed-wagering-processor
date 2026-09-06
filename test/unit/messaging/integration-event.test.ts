import { describe, expect, test } from 'bun:test';

import { IntegrationEvent } from '../../../src/messaging/domain/integration-event.js';
import { WalletOpenedEvent } from '../../../src/messaging/application/events/wallet-opened.event.js';
import {
  WagerTransactionPendingReferenceEvent,
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  WalletBalanceChangedEvent,
} from '../../../src/messaging/application/events/wager-transaction.events.js';

const OCCURRED_AT = new Date('2026-09-04T12:00:00.000Z');

describe('IntegrationEvent', () => {
  test('serializes and freezes the foundational versioned envelope', () => {
    const event = IntegrationEvent.create({
      eventId: 'event-1',
      eventType: 'TestEvent',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'command-1',
      occurredAt: OCCURRED_AT,
      version: 1,
      data: { money: { amount: '1.00', currency: 'BRL' }, outcome: 'PROCESSED' },
    });

    const envelope = event.toEnvelope();

    expect(envelope).toEqual({
      eventId: 'event-1',
      eventType: 'TestEvent',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'command-1',
      occurredAt: '2026-09-04T12:00:00.000Z',
      version: 1,
      data: { money: { amount: '1.00', currency: 'BRL' }, outcome: 'PROCESSED' },
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.data)).toBe(true);
    expect(Object.isFrozen(envelope.data.money)).toBe(true);
  });

  test('rejects unsupported versions and non-canonical event data', () => {
    expect(() =>
      IntegrationEvent.create({
        eventId: 'event-1',
        eventType: 'TestEvent',
        aggregateId: 'wallet-1',
        correlationId: 'correlation-1',
        occurredAt: OCCURRED_AT,
        version: 0,
        data: {},
      }),
    ).toThrow('Integration event version must be a positive integer');

    expect(() =>
      IntegrationEvent.create({
        eventId: 'event-1',
        eventType: 'TestEvent',
        aggregateId: 'wallet-1',
        correlationId: 'correlation-1',
        occurredAt: OCCURRED_AT,
        version: 1.5,
        data: {},
      }),
    ).toThrow('Integration event version must be a positive integer');

    expect(() =>
      IntegrationEvent.create({
        eventId: 'event-1',
        eventType: 'TestEvent',
        aggregateId: 'wallet-1',
        correlationId: 'correlation-1',
        occurredAt: OCCURRED_AT,
        version: 1,
        data: { ambiguous: undefined },
      }),
    ).toThrow('Unsupported canonical JSON value');
  });
});

describe('concrete integration events', () => {
  test('serializes WalletOpened with its immutable identity and Money data', () => {
    const event = WalletOpenedEvent.from({
      eventId: 'event-wallet-opened',
      walletId: 'wallet-1',
      playerId: 'player-1',
      initialBalance: { amount: '1000.00', currency: 'BRL' },
      correlationId: 'correlation-1',
      causationId: 'create-wallet-request-1',
      occurredAt: OCCURRED_AT,
    });

    const envelope = event.toEnvelope();

    expect(envelope).toEqual({
      eventId: 'event-wallet-opened',
      eventType: 'WalletOpened',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'create-wallet-request-1',
      occurredAt: '2026-09-04T12:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        playerId: 'player-1',
        initialBalance: { amount: '1000.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.data)).toBe(true);
    expect(Object.isFrozen(envelope.data.initialBalance)).toBe(true);

    expect(() =>
      WalletOpenedEvent.from({
        eventId: ' ',
        walletId: 'wallet-1',
        playerId: 'player-1',
        initialBalance: { amount: '1000.00', currency: 'BRL' },
        correlationId: 'correlation-1',
        occurredAt: OCCURRED_AT,
      }),
    ).toThrow('eventId must be a non-blank normalized string');
  });

  test('serializes WagerTransactionProcessed with the original observed balance', () => {
    const event = WagerTransactionProcessedEvent.from({
      eventId: 'event-processed',
      transactionId: 'transaction-1',
      walletId: 'wallet-1',
      providerId: 'provider-1',
      kind: 'BET',
      balance: { amount: '920.00', currency: 'BRL' },
      correlationId: 'correlation-1',
      causationId: 'message-1',
      occurredAt: OCCURRED_AT,
    });

    expect(event.toEnvelope()).toEqual({
      eventId: 'event-processed',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'message-1',
      occurredAt: '2026-09-04T12:00:00.000Z',
      version: 1,
      data: {
        transactionId: 'transaction-1',
        walletId: 'wallet-1',
        providerId: 'provider-1',
        kind: 'BET',
        originalObservedBalance: { amount: '920.00', currency: 'BRL' },
      },
    });
    expect(Object.isFrozen(event.data.originalObservedBalance)).toBe(true);
  });

  test('serializes WagerTransactionRejected with the stable failure code', () => {
    const event = WagerTransactionRejectedEvent.from({
      eventId: 'event-rejected',
      transactionId: 'transaction-2',
      walletId: 'wallet-1',
      providerId: 'provider-1',
      kind: 'BET',
      balance: { amount: '20.00', currency: 'BRL' },
      failureCode: 'INSUFFICIENT_FUNDS',
      correlationId: 'correlation-2',
      causationId: 'message-2',
      occurredAt: OCCURRED_AT,
    });

    expect(event.toEnvelope()).toEqual({
      eventId: 'event-rejected',
      eventType: 'WagerTransactionRejected',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-2',
      causationId: 'message-2',
      occurredAt: '2026-09-04T12:00:00.000Z',
      version: 1,
      data: {
        transactionId: 'transaction-2',
        walletId: 'wallet-1',
        providerId: 'provider-1',
        kind: 'BET',
        failureCode: 'INSUFFICIENT_FUNDS',
        originalObservedBalance: { amount: '20.00', currency: 'BRL' },
      },
    });
    expect(Object.isFrozen(event.data.originalObservedBalance)).toBe(true);
  });

  test('serializes WagerTransactionPendingReference with its fixed retry expiration', () => {
    const event = WagerTransactionPendingReferenceEvent.from({
      eventId: 'event-pending',
      transactionId: 'transaction-3',
      walletId: 'wallet-1',
      providerId: 'provider-1',
      kind: 'REFUND',
      referenceExternalTransactionId: 'provider-transaction-1',
      retryExpiresAt: new Date('2026-09-05T12:00:00.000Z'),
      correlationId: 'correlation-3',
      causationId: 'message-3',
      occurredAt: OCCURRED_AT,
    });

    expect(event.toEnvelope()).toEqual({
      eventId: 'event-pending',
      eventType: 'WagerTransactionPendingReference',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-3',
      causationId: 'message-3',
      occurredAt: '2026-09-04T12:00:00.000Z',
      version: 1,
      data: {
        transactionId: 'transaction-3',
        walletId: 'wallet-1',
        providerId: 'provider-1',
        kind: 'REFUND',
        referenceExternalTransactionId: 'provider-transaction-1',
        retryExpiresAt: '2026-09-05T12:00:00.000Z',
      },
    });
  });

  test('serializes WalletBalanceChanged with exact public Money values', () => {
    const event = WalletBalanceChangedEvent.from({
      eventId: 'event-balance-changed',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: 'DEBIT',
      money: { amount: '80.00', currency: 'BRL' },
      balanceBefore: { amount: '1000.00', currency: 'BRL' },
      balanceAfter: { amount: '920.00', currency: 'BRL' },
      walletVersion: 2,
      correlationId: 'correlation-1',
      causationId: 'message-1',
      occurredAt: OCCURRED_AT,
    });

    const envelope = event.toEnvelope();

    expect(envelope).toEqual({
      eventId: 'event-balance-changed',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'message-1',
      occurredAt: '2026-09-04T12:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: 'DEBIT',
        money: { amount: '80.00', currency: 'BRL' },
        balanceBefore: { amount: '1000.00', currency: 'BRL' },
        balanceAfter: { amount: '920.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(Object.isFrozen(envelope.data.money)).toBe(true);
    expect(Object.isFrozen(envelope.data.balanceBefore)).toBe(true);
    expect(Object.isFrozen(envelope.data.balanceAfter)).toBe(true);
  });
});
