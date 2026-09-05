import { cloneAndFreezeCanonicalJson } from '../../shared/domain/immutable-json.js';

type EventData = Readonly<Record<string, unknown>>;

export interface IntegrationEventState<
  TType extends string = string,
  TData extends EventData = EventData,
> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly version: number;
  readonly data: TData;
}

export interface IntegrationEventEnvelope<
  TType extends string = string,
  TData extends EventData = EventData,
> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: TData;
}

function assertNonBlank(value: string, fieldName: string): void {
  if (value.trim().length === 0 || value.trim() !== value) {
    throw new TypeError(`${fieldName} must be a non-blank normalized string`);
  }
}

export class IntegrationEvent<TType extends string = string, TData extends EventData = EventData> {
  public readonly eventId: string;
  public readonly eventType: TType;
  public readonly aggregateId: string;
  public readonly correlationId: string;
  public readonly causationId: string | undefined;
  public readonly version: number;
  public readonly data: TData;
  readonly #occurredAtEpoch: number;

  protected constructor(state: IntegrationEventState<TType, TData>) {
    assertNonBlank(state.eventId, 'eventId');
    assertNonBlank(state.eventType, 'eventType');
    assertNonBlank(state.aggregateId, 'aggregateId');
    assertNonBlank(state.correlationId, 'correlationId');
    if (state.causationId !== undefined) {
      assertNonBlank(state.causationId, 'causationId');
    }
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new TypeError('Integration event version must be a positive integer');
    }
    if (!Number.isFinite(state.occurredAt.getTime())) {
      throw new TypeError('Integration event timestamp must be valid');
    }

    this.eventId = state.eventId;
    this.eventType = state.eventType;
    this.aggregateId = state.aggregateId;
    this.correlationId = state.correlationId;
    this.causationId = state.causationId;
    this.#occurredAtEpoch = state.occurredAt.getTime();
    this.version = state.version;
    this.data = cloneAndFreezeCanonicalJson(state.data);
    Object.freeze(this);
  }

  public static create<TType extends string, TData extends EventData>(
    state: IntegrationEventState<TType, TData>,
  ): IntegrationEvent<TType, TData> {
    return new IntegrationEvent(state);
  }

  public toEnvelope(): IntegrationEventEnvelope<TType, TData> {
    return Object.freeze({
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: new Date(this.#occurredAtEpoch).toISOString(),
      version: this.version,
      data: this.data,
    });
  }
}
