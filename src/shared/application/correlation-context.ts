export interface CorrelationContext {
  readonly correlationId: string;
  readonly messageId?: string;
  readonly transactionId?: string;
  readonly walletId?: string;
  readonly providerId?: string;
  readonly outboxMessageId?: string;
  readonly eventId?: string;
  readonly causationId?: string;
}

export function createCorrelationContext(input: CorrelationContext): CorrelationContext {
  const {
    correlationId,
    messageId,
    transactionId,
    walletId,
    providerId,
    outboxMessageId,
    eventId,
    causationId,
  } = input;

  return Object.freeze({
    correlationId,
    ...(messageId === undefined ? {} : { messageId }),
    ...(transactionId === undefined ? {} : { transactionId }),
    ...(walletId === undefined ? {} : { walletId }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(outboxMessageId === undefined ? {} : { outboxMessageId }),
    ...(eventId === undefined ? {} : { eventId }),
    ...(causationId === undefined ? {} : { causationId }),
  });
}
