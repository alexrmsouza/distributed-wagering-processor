import {
  WagerTransactionPendingReferenceEvent,
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  WalletBalanceChangedEvent,
} from '../../messaging/application/events/wager-transaction.events.js';
import { OutboxMessage } from '../../messaging/domain/outbox-message.js';
import type { Money } from '../../shared/domain/money.js';
import type { Wallet } from '../../wallet/domain/wallet.js';
import type { FailureCode } from '../domain/failure-code.js';
import type { ReversalDirection } from '../domain/reversal-rules.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { ProcessWagerTransactionCommand } from './process-wager-transaction.use-case.js';

interface EventIdentity {
  readonly outboxMessageId: string;
  readonly eventId: string;
}

interface EventContext extends EventIdentity {
  readonly command: ProcessWagerTransactionCommand;
  readonly occurredAt: Date;
  readonly transaction: WagerTransaction;
}

function causation(command: ProcessWagerTransactionCommand): Readonly<{ causationId?: string }> {
  return command.causationId === undefined ? {} : { causationId: command.causationId };
}

function toSafeVersion(version: bigint): number {
  const value = Number(version);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('Wallet version exceeds the safe event range');
  }
  return value;
}

export function createPendingReferenceOutboxMessage(
  input: EventContext & {
    readonly referenceExternalTransactionId: string;
    readonly retryExpiresAt: Date;
  },
): OutboxMessage {
  return OutboxMessage.enqueue({
    id: input.outboxMessageId,
    event: WagerTransactionPendingReferenceEvent.from({
      eventId: input.eventId,
      transactionId: input.transaction.id,
      walletId: input.transaction.walletId,
      providerId: input.transaction.providerId,
      kind: input.transaction.kind as 'REFUND' | 'ROLLBACK',
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      retryExpiresAt: input.retryExpiresAt,
      correlationId: input.command.correlationId,
      ...causation(input.command),
      occurredAt: input.occurredAt,
    }),
  });
}

export function createRejectedOutboxMessage(
  input: EventContext & { readonly failureCode: FailureCode; readonly balance: Money },
): OutboxMessage {
  return OutboxMessage.enqueue({
    id: input.outboxMessageId,
    event: WagerTransactionRejectedEvent.from({
      eventId: input.eventId,
      transactionId: input.transaction.id,
      walletId: input.transaction.walletId,
      providerId: input.transaction.providerId,
      kind: input.command.kind,
      failureCode: input.failureCode,
      balance: input.balance.toJSON(),
      correlationId: input.command.correlationId,
      ...causation(input.command),
      occurredAt: input.occurredAt,
    }),
  });
}

export function createBalanceChangedOutboxMessage(
  input: EventContext & {
    readonly direction: ReversalDirection;
    readonly previousWallet: Wallet;
    readonly changedWallet: Wallet;
  },
): OutboxMessage {
  return OutboxMessage.enqueue({
    id: input.outboxMessageId,
    event: WalletBalanceChangedEvent.from({
      eventId: input.eventId,
      walletId: input.previousWallet.id,
      transactionId: input.transaction.id,
      direction: input.direction,
      money: input.command.money.toJSON(),
      balanceBefore: input.previousWallet.balance.toJSON(),
      balanceAfter: input.changedWallet.balance.toJSON(),
      walletVersion: toSafeVersion(input.changedWallet.version),
      correlationId: input.command.correlationId,
      ...causation(input.command),
      occurredAt: input.occurredAt,
    }),
  });
}

export function createProcessedOutboxMessage(input: EventContext): OutboxMessage {
  if (input.transaction.observedBalance === null) {
    throw new Error('Processed Wager transaction does not contain an observed balance');
  }
  return OutboxMessage.enqueue({
    id: input.outboxMessageId,
    event: WagerTransactionProcessedEvent.from({
      eventId: input.eventId,
      transactionId: input.transaction.id,
      walletId: input.transaction.walletId,
      providerId: input.transaction.providerId,
      kind: input.command.kind,
      balance: input.transaction.observedBalance.toJSON(),
      correlationId: input.command.correlationId,
      ...causation(input.command),
      occurredAt: input.occurredAt,
    }),
  });
}
