import type { EntityManager } from '@mikro-orm/core';

import {
  executeStatement,
  queryRows,
} from '../../shared/infrastructure/persistence/transactional-query.js';
import { InboxMessageMapper } from '../../shared/infrastructure/persistence/message.mappers.js';
import type { InboxMessageRow } from '../../shared/infrastructure/persistence/message-row.schemas.js';
import type { InboxClaim, InboxRepository } from '../application/inbox.repository.js';
import type { InboxMessage } from '../domain/inbox-message.js';

interface InboxDatabaseRow {
  readonly consumer_name: string;
  readonly message_id: string;
  readonly payload_hash: string;
  readonly transaction_id: string | null;
  readonly received_at: Date;
  readonly processed_at: Date | null;
}

const INBOX_COLUMNS = `
  consumer_name, message_id, payload_hash, transaction_id, received_at, processed_at
`;

export class MikroOrmInboxRepository implements InboxRepository {
  public readonly transactionBound = true as const;

  public constructor(private readonly entityManager: EntityManager) {}

  public async claim(message: InboxMessage): Promise<InboxClaim> {
    const state = message.toState();
    const rows = await queryRows<{ readonly message_id: string }>(
      this.entityManager,
      `insert into inbox_messages
         (consumer_name, message_id, payload_hash, transaction_id, received_at, processed_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning message_id`,
      [
        state.consumerName,
        state.messageId,
        state.payloadHash,
        state.transactionId,
        state.receivedAt,
        state.processedAt,
      ],
    );

    return rows.length === 1 ? 'CLAIMED' : 'DUPLICATE';
  }

  public async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const rows = await queryRows<InboxDatabaseRow>(
      this.entityManager,
      `select ${INBOX_COLUMNS}
         from inbox_messages
        where consumer_name = ? and message_id = ?
        for update`,
      [consumerName, messageId],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    const mappedRow: InboxMessageRow = {
      consumerName: row.consumer_name,
      messageId: row.message_id,
      payloadHash: row.payload_hash,
      transactionId: row.transaction_id,
      receivedAt: new Date(row.received_at),
      processedAt: row.processed_at === null ? null : new Date(row.processed_at),
    };
    return InboxMessageMapper.toDomain(mappedRow);
  }

  public async save(message: InboxMessage): Promise<void> {
    const state = message.toState();
    await executeStatement(
      this.entityManager,
      `update inbox_messages
          set transaction_id = ?, processed_at = ?
        where consumer_name = ? and message_id = ?`,
      [state.transactionId, state.processedAt, state.consumerName, state.messageId],
    );
  }
}
