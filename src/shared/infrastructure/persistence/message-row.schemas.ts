import { EntitySchema } from '@mikro-orm/core';

export class InboxMessageRow {
  declare consumerName: string;
  declare messageId: string;
  declare payloadHash: string;
  declare transactionId: string | null;
  declare receivedAt: Date;
  declare processedAt: Date | null;
}

export class OutboxMessageRow {
  declare id: string;
  declare eventId: string;
  declare aggregateId: string;
  declare eventType: string;
  declare version: number;
  declare payload: Record<string, unknown>;
  declare correlationId: string;
  declare causationId: string | null;
  declare occurredAt: Date;
  declare attempts: number;
  declare nextAttemptAt: Date;
  declare leaseToken: string | null;
  declare leaseExpiresAt: Date | null;
  declare publishedAt: Date | null;
}

const timestamp = { type: Date } as const;
const uuid = { type: 'uuid' } as const;

export const InboxMessageRowSchema = new EntitySchema<InboxMessageRow>({
  class: InboxMessageRow,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', primary: true },
    messageId: { type: 'string', fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash', length: 64 },
    transactionId: { ...uuid, fieldName: 'transaction_id', nullable: true },
    receivedAt: { ...timestamp, fieldName: 'received_at' },
    processedAt: { ...timestamp, fieldName: 'processed_at', nullable: true },
  },
});

export const OutboxMessageRowSchema = new EntitySchema<OutboxMessageRow>({
  class: OutboxMessageRow,
  tableName: 'outbox_messages',
  properties: {
    id: { ...uuid, primary: true },
    eventId: { ...uuid, fieldName: 'event_id' },
    aggregateId: { ...uuid, fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    version: { type: 'integer' },
    payload: { type: 'json' },
    correlationId: { type: 'string', fieldName: 'correlation_id' },
    causationId: { type: 'string', fieldName: 'causation_id', nullable: true },
    occurredAt: { ...timestamp, fieldName: 'occurred_at' },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamp, fieldName: 'next_attempt_at' },
    leaseToken: { ...uuid, fieldName: 'lease_token', nullable: true },
    leaseExpiresAt: { ...timestamp, fieldName: 'lease_expires_at', nullable: true },
    publishedAt: { ...timestamp, fieldName: 'published_at', nullable: true },
  },
});
