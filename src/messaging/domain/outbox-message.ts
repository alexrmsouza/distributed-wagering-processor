import { Entity } from '../../shared/domain/entity.js';
import { cloneAndFreezeCanonicalJson } from '../../shared/domain/immutable-json.js';
import type { IntegrationEvent } from '../application/integration-event.js';

export interface OutboxMessageState {
  readonly id: string;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly version: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly publishedAt: Date | null;
}

export class OutboxMessage extends Entity {
  readonly #state: OutboxMessageState;

  private constructor(state: OutboxMessageState) {
    super(state.id);
    this.#state = Object.freeze({
      ...state,
      payload: cloneAndFreezeCanonicalJson(state.payload),
      occurredAt: new Date(state.occurredAt),
      nextAttemptAt: new Date(state.nextAttemptAt),
      leaseExpiresAt: state.leaseExpiresAt === null ? null : new Date(state.leaseExpiresAt),
      publishedAt: state.publishedAt === null ? null : new Date(state.publishedAt),
    });
    Object.freeze(this);
  }

  public static enqueue(options: {
    readonly id: string;
    readonly event: IntegrationEvent;
  }): OutboxMessage {
    const envelope = options.event.toEnvelope();

    return OutboxMessage.rehydrate({
      id: options.id,
      eventId: envelope.eventId,
      aggregateId: envelope.aggregateId,
      eventType: envelope.eventType,
      version: envelope.version,
      payload: { ...envelope },
      correlationId: envelope.correlationId,
      causationId: envelope.causationId ?? null,
      occurredAt: new Date(envelope.occurredAt),
      attempts: 0,
      nextAttemptAt: new Date(envelope.occurredAt),
      leaseToken: null,
      leaseExpiresAt: null,
      publishedAt: null,
    });
  }

  public static rehydrate(state: OutboxMessageState): OutboxMessage {
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new TypeError('Outbox event version must be a positive integer');
    }
    if (!Number.isInteger(state.attempts) || state.attempts < 0) {
      throw new TypeError('Outbox attempts must be a non-negative integer');
    }
    if ((state.leaseToken === null) !== (state.leaseExpiresAt === null)) {
      throw new TypeError('Outbox lease token and expiry must be set together');
    }

    return new OutboxMessage(state);
  }

  public toState(): OutboxMessageState {
    return Object.freeze({
      ...this.#state,
      payload: this.#state.payload,
      occurredAt: new Date(this.#state.occurredAt),
      nextAttemptAt: new Date(this.#state.nextAttemptAt),
      leaseExpiresAt:
        this.#state.leaseExpiresAt === null ? null : new Date(this.#state.leaseExpiresAt),
      publishedAt: this.#state.publishedAt === null ? null : new Date(this.#state.publishedAt),
    });
  }
}
