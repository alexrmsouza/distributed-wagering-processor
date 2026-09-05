import { expect, test } from 'bun:test';

import { InboxMessage } from '../../../src/messaging/domain/inbox-message.js';
import { OutboxMessage } from '../../../src/messaging/domain/outbox-message.js';
import {
  InboxMessageMapper,
  OutboxMessageMapper,
} from '../../../src/shared/infrastructure/persistence/message.mappers.js';

test('round-trips an Inbox message through its explicit persistence row', () => {
  const message = InboxMessage.rehydrate({
    consumerName: 'wager-consumer',
    messageId: 'message-1',
    payloadHash: 'a'.repeat(64),
    transactionId: 'transaction-1',
    receivedAt: new Date('2026-09-04T12:00:00.000Z'),
    processedAt: new Date('2026-09-04T12:00:01.000Z'),
  });

  const row = InboxMessageMapper.toRow(message);
  const restored = InboxMessageMapper.toDomain(row);

  expect(restored.toState()).toEqual(message.toState());
  expect(restored).not.toBe(message);
});

test('round-trips an Outbox message without losing lease or event data', () => {
  const message = OutboxMessage.rehydrate({
    id: 'outbox-1',
    eventId: 'event-1',
    aggregateId: 'wallet-1',
    eventType: 'WalletOpened',
    version: 1,
    payload: { money: { amount: '1.00', currency: 'BRL' }, walletId: 'wallet-1' },
    correlationId: 'correlation-1',
    causationId: null,
    occurredAt: new Date('2026-09-04T12:00:00.000Z'),
    attempts: 2,
    nextAttemptAt: new Date('2026-09-04T12:01:00.000Z'),
    leaseToken: 'lease-1',
    leaseExpiresAt: new Date('2026-09-04T12:00:30.000Z'),
    publishedAt: null,
  });

  const row = OutboxMessageMapper.toRow(message);
  const restored = OutboxMessageMapper.toDomain(row);

  expect(restored.toState()).toEqual(message.toState());
  expect(restored).not.toBe(message);
  expect(Object.isFrozen(restored.toState().payload.money)).toBe(true);
});
