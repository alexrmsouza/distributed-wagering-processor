import type { EntityManager } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';

import type { IntegrationEventEnvelope } from '../../src/messaging/application/integration-event.js';
import { InboxMessage } from '../../src/messaging/domain/inbox-message.js';
import { MikroOrmInboxRepository } from '../../src/messaging/infrastructure/inbox.repository.js';
import { hashPayload } from '../../src/shared/domain/payload-hash.js';

export type EventSinkResult = Readonly<{
  status: 'PROCESSED' | 'DUPLICATE';
  eventId: string;
}>;

class DivergentEventEnvelopeError extends Error {
  public readonly code = 'IDEMPOTENCY_CONFLICT';

  public constructor() {
    super('Integration event identity was reused with a divergent envelope');
    this.name = 'DivergentEventEnvelopeError';
  }
}

export interface EventSinkConsumerOptions {
  readonly orm: MikroORM;
  readonly consumerName: string;
  readonly onEvent: (
    event: IntegrationEventEnvelope,
    entityManager: EntityManager,
  ) => Promise<void>;
}

export class EventSinkConsumer {
  public constructor(private readonly options: EventSinkConsumerOptions) {
    if (
      options.consumerName.trim().length === 0 ||
      options.consumerName !== options.consumerName.trim()
    ) {
      throw new TypeError('Event sink consumer name must be normalized');
    }
  }

  public processEnvelope(event: IntegrationEventEnvelope): Promise<EventSinkResult> {
    const payloadHash = hashPayload(event);
    return this.options.orm.em.transactional(async (entityManager) => {
      const inbox = new MikroOrmInboxRepository(entityManager);
      const receivedAt = new Date();
      const message = InboxMessage.create({
        consumerName: this.options.consumerName,
        messageId: event.eventId,
        payloadHash,
        receivedAt,
      });
      const claim = await inbox.claim(message);

      if (claim === 'DUPLICATE') {
        const existing = await inbox.find(this.options.consumerName, event.eventId);
        if (existing?.payloadHash !== payloadHash) {
          throw new DivergentEventEnvelopeError();
        }
        if (existing.processedAt === null) {
          throw new Error('Integration event Inbox record is incomplete');
        }
        return Object.freeze({ status: 'DUPLICATE', eventId: event.eventId });
      }

      await this.options.onEvent(event, entityManager);
      await inbox.save(message.complete(null, new Date()));
      return Object.freeze({ status: 'PROCESSED', eventId: event.eventId });
    });
  }
}
