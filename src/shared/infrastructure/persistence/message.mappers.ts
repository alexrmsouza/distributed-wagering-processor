import { InboxMessage } from '../../../messaging/domain/inbox-message.js';
import { OutboxMessage } from '../../../messaging/domain/outbox-message.js';
import { InboxMessageRow, OutboxMessageRow } from './message-row.schemas.js';

export const InboxMessageMapper = {
  toDomain(row: InboxMessageRow): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: row.consumerName,
      messageId: row.messageId,
      payloadHash: row.payloadHash,
      transactionId: row.transactionId,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
    });
  },

  toRow(message: InboxMessage): InboxMessageRow {
    const state = message.toState();
    const row = new InboxMessageRow();
    Object.assign(row, state);
    return row;
  },
};

export const OutboxMessageMapper = {
  toDomain(row: OutboxMessageRow): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: row.id,
      eventId: row.eventId,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      version: row.version,
      payload: row.payload,
      correlationId: row.correlationId,
      causationId: row.causationId,
      occurredAt: row.occurredAt,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      leaseToken: row.leaseToken,
      leaseExpiresAt: row.leaseExpiresAt,
      publishedAt: row.publishedAt,
    });
  },

  toRow(message: OutboxMessage): OutboxMessageRow {
    const state = message.toState();
    const row = new OutboxMessageRow();
    Object.assign(row, state, { payload: { ...state.payload } });
    return row;
  },
};
