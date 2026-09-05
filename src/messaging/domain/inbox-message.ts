import { Entity } from '../../shared/domain/entity.js';

export interface InboxMessageState {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly transactionId: string | null;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
}

export class InboxMessage extends Entity {
  public readonly consumerName: string;
  public readonly messageId: string;
  public readonly payloadHash: string;
  public readonly transactionId: string | null;
  readonly #receivedAtEpoch: number;
  readonly #processedAtEpoch: number | null;

  private constructor(state: InboxMessageState) {
    super(`${state.consumerName}:${state.messageId}`);
    this.consumerName = state.consumerName;
    this.messageId = state.messageId;
    this.payloadHash = state.payloadHash;
    this.transactionId = state.transactionId;
    this.#receivedAtEpoch = state.receivedAt.getTime();
    this.#processedAtEpoch = state.processedAt?.getTime() ?? null;
    Object.freeze(this);
  }

  public static create(
    state: Omit<InboxMessageState, 'transactionId' | 'processedAt'>,
  ): InboxMessage {
    return InboxMessage.rehydrate({ ...state, transactionId: null, processedAt: null });
  }

  public static rehydrate(state: InboxMessageState): InboxMessage {
    if (!/^[0-9a-f]{64}$/.test(state.payloadHash)) {
      throw new TypeError('Inbox payload hash must be lowercase SHA-256');
    }
    if (!Number.isFinite(state.receivedAt.getTime())) {
      throw new TypeError('Inbox received timestamp must be valid');
    }
    if (state.processedAt !== null && state.processedAt.getTime() < state.receivedAt.getTime()) {
      throw new TypeError('Inbox processed timestamp cannot precede receipt');
    }

    return new InboxMessage(state);
  }

  public complete(transactionId: string | null, processedAt: Date): InboxMessage {
    if (this.processedAt !== null) {
      throw new TypeError('Inbox message is already complete');
    }

    return InboxMessage.rehydrate({
      ...this.toState(),
      transactionId,
      processedAt,
    });
  }

  public get receivedAt(): Date {
    return new Date(this.#receivedAtEpoch);
  }

  public get processedAt(): Date | null {
    return this.#processedAtEpoch === null ? null : new Date(this.#processedAtEpoch);
  }

  public toState(): InboxMessageState {
    return Object.freeze({
      consumerName: this.consumerName,
      messageId: this.messageId,
      payloadHash: this.payloadHash,
      transactionId: this.transactionId,
      receivedAt: this.receivedAt,
      processedAt: this.processedAt,
    });
  }
}
