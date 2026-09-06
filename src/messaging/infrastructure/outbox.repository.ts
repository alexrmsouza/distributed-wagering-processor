import type { EntityManager } from '@mikro-orm/core';

import { executeStatement } from '../../shared/infrastructure/persistence/transactional-query.js';
import { queryRows } from '../../shared/infrastructure/persistence/transactional-query.js';
import type { ClaimDueOutboxMessages, OutboxRepository } from '../application/outbox.repository.js';
import type { OutboxBlockReason, OutboxMessage } from '../domain/outbox-message.js';
import { OutboxMessageMapper } from '../../shared/infrastructure/persistence/message.mappers.js';
import type { OutboxMessageRow } from '../../shared/infrastructure/persistence/message-row.schemas.js';

interface OutboxDatabaseRow {
  readonly id: string;
  readonly event_id: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly version: number;
  readonly payload: Record<string, unknown>;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly occurred_at: Date;
  readonly attempts: number;
  readonly next_attempt_at: Date;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | null;
  readonly published_at: Date | null;
  readonly blocked_at: Date | null;
  readonly last_block_reason: OutboxBlockReason | null;
  readonly replay_count: number;
  readonly last_replayed_at: Date | null;
}

const OUTBOX_RETURNING_COLUMNS = `
  message.id, message.event_id, message.aggregate_id, message.event_type,
  message.version, message.payload, message.correlation_id, message.causation_id,
  message.occurred_at, message.attempts, message.next_attempt_at,
  message.lease_token, message.lease_expires_at, message.published_at,
  message.blocked_at, message.last_block_reason, message.replay_count,
  message.last_replayed_at
`;

function toDomain(row: OutboxDatabaseRow): OutboxMessage {
  const mappedRow: OutboxMessageRow = {
    id: row.id,
    eventId: row.event_id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    version: row.version,
    payload: row.payload,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at === null ? null : new Date(row.lease_expires_at),
    publishedAt: row.published_at === null ? null : new Date(row.published_at),
    blockedAt: row.blocked_at === null ? null : new Date(row.blocked_at),
    lastBlockReason: row.last_block_reason,
    replayCount: row.replay_count,
    lastReplayedAt: row.last_replayed_at === null ? null : new Date(row.last_replayed_at),
  };
  return OutboxMessageMapper.toDomain(mappedRow);
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  public readonly transactionBound = true as const;

  public constructor(private readonly entityManager: EntityManager) {}

  public async insert(message: OutboxMessage): Promise<void> {
    const state = message.toState();
    await executeStatement(
      this.entityManager,
      `insert into outbox_messages
         (id, event_id, aggregate_id, event_type, version, payload, correlation_id,
          causation_id, occurred_at, attempts, next_attempt_at, lease_token,
          lease_expires_at, published_at, blocked_at, last_block_reason,
          replay_count, last_replayed_at)
       values (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        state.id,
        state.eventId,
        state.aggregateId,
        state.eventType,
        state.version,
        JSON.stringify(state.payload),
        state.correlationId,
        state.causationId,
        state.occurredAt,
        state.attempts,
        state.nextAttemptAt,
        state.leaseToken,
        state.leaseExpiresAt,
        state.publishedAt,
        state.blockedAt,
        state.lastBlockReason,
        state.replayCount,
        state.lastReplayedAt,
      ],
    );
  }

  public async claimDue(options: ClaimDueOutboxMessages): Promise<readonly OutboxMessage[]> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new RangeError('Outbox claim limit must be a positive safe integer');
    }
    if (options.leaseExpiresAt.getTime() <= options.now.getTime()) {
      throw new RangeError('Outbox lease expiry must be after claim time');
    }

    const rows = await queryRows<OutboxDatabaseRow>(
      this.entityManager,
      `with candidates as (
         select candidate.id
           from outbox_messages candidate
          where candidate.published_at is null
            and candidate.blocked_at is null
            and candidate.next_attempt_at <= ?
            and (
              candidate.lease_token is null
              or candidate.lease_expires_at <= ?
            )
            and not exists (
              select 1
                from outbox_messages earlier
               where earlier.aggregate_id = candidate.aggregate_id
                 and earlier.published_at is null
                 and (earlier.occurred_at, earlier.id) <
                     (candidate.occurred_at, candidate.id)
            )
          order by candidate.next_attempt_at, candidate.occurred_at, candidate.id
          for update of candidate skip locked
          limit ?
       )
       update outbox_messages message
          set lease_token = ?, lease_expires_at = ?
         from candidates
        where message.id = candidates.id
       returning ${OUTBOX_RETURNING_COLUMNS}`,
      [options.now, options.now, options.limit, options.leaseToken, options.leaseExpiresAt],
    );

    return Object.freeze(rows.map(toDomain));
  }

  public async markPublished(
    outboxId: string,
    leaseToken: string,
    publishedAt: Date,
  ): Promise<boolean> {
    const rows = await queryRows<{ readonly id: string }>(
      this.entityManager,
      `update outbox_messages
          set published_at = ?, lease_token = null, lease_expires_at = null
        where id = ? and published_at is null and blocked_at is null and lease_token = ?
       returning id`,
      [publishedAt, outboxId, leaseToken],
    );
    return rows.length === 1;
  }

  public async reschedule(
    outboxId: string,
    leaseToken: string,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(attempts) || attempts < 1) {
      throw new RangeError('Outbox retry attempts must be a positive safe integer');
    }
    const rows = await queryRows<{ readonly id: string }>(
      this.entityManager,
      `update outbox_messages
          set attempts = ?, next_attempt_at = ?, lease_token = null, lease_expires_at = null
        where id = ? and published_at is null and blocked_at is null and lease_token = ?
       returning id`,
      [attempts, nextAttemptAt, outboxId, leaseToken],
    );
    return rows.length === 1;
  }

  public async block(
    outboxId: string,
    leaseToken: string,
    attempts: number,
    reason: OutboxBlockReason,
    blockedAt: Date,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(attempts) || attempts < 1) {
      throw new RangeError('Outbox block attempts must be a positive safe integer');
    }
    const rows = await queryRows<{ readonly id: string }>(
      this.entityManager,
      `update outbox_messages
          set attempts = ?, blocked_at = ?, last_block_reason = ?,
              lease_token = null, lease_expires_at = null
        where id = ? and published_at is null and blocked_at is null and lease_token = ?
       returning id`,
      [attempts, blockedAt, reason, outboxId, leaseToken],
    );
    return rows.length === 1;
  }

  public async replayBlocked(
    outboxId: string,
    operatorId: string,
    replayedAt: Date,
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9._@:-]{1,128}$/.test(operatorId)) {
      throw new TypeError('Outbox replay operator identity is invalid');
    }
    const blockedRows = await queryRows<{
      readonly attempts: number;
      readonly last_block_reason: OutboxBlockReason;
    }>(
      this.entityManager,
      `select attempts, last_block_reason
         from outbox_messages
        where id = ? and published_at is null and blocked_at is not null
        for update`,
      [outboxId],
    );
    const blocked = blockedRows[0];
    if (blocked === undefined) {
      return false;
    }

    await executeStatement(
      this.entityManager,
      `insert into outbox_replay_audit
         (id, outbox_id, operator_id, blocked_reason, previous_attempts, replayed_at)
       values (gen_random_uuid(), ?, ?, ?, ?, ?)`,
      [outboxId, operatorId, blocked.last_block_reason, blocked.attempts, replayedAt],
    );
    const rows = await queryRows<{ readonly id: string }>(
      this.entityManager,
      `update outbox_messages
          set blocked_at = null, attempts = 0, next_attempt_at = ?,
              lease_token = null, lease_expires_at = null,
              replay_count = replay_count + 1, last_replayed_at = ?
        where id = ? and published_at is null and blocked_at is not null
       returning id`,
      [replayedAt, replayedAt, outboxId],
    );
    return rows.length === 1;
  }
}
