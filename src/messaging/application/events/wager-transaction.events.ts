import type { FailureCode } from '../../../wagering/domain/failure-code.js';
import type { LedgerDirection } from '../../../wallet/domain/ledger-hash-chain.js';
import type { PublicMoney } from '../../../shared/domain/money.js';
import { IntegrationEvent, type IntegrationEventState } from '../../domain/integration-event.js';

type PublicWagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

interface WagerEventIdentity {
  readonly eventId: string;
  readonly transactionId: string;
  readonly walletId: string;
  readonly providerId: string;
  readonly kind: PublicWagerKind;
  readonly balance: PublicMoney;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}

export interface WagerTransactionProcessedData extends Readonly<Record<string, unknown>> {
  readonly transactionId: string;
  readonly walletId: string;
  readonly providerId: string;
  readonly kind: PublicWagerKind;
  readonly originalObservedBalance: PublicMoney;
}

export class WagerTransactionProcessedEvent extends IntegrationEvent<
  'WagerTransactionProcessed',
  WagerTransactionProcessedData
> {
  private constructor(
    state: Omit<
      IntegrationEventState<'WagerTransactionProcessed', WagerTransactionProcessedData>,
      'eventType' | 'version'
    >,
  ) {
    super({ ...state, eventType: 'WagerTransactionProcessed', version: 1 });
  }

  public static from(state: WagerEventIdentity): WagerTransactionProcessedEvent {
    return new WagerTransactionProcessedEvent({
      eventId: state.eventId,
      aggregateId: state.walletId,
      correlationId: state.correlationId,
      ...(state.causationId === undefined ? {} : { causationId: state.causationId }),
      occurredAt: state.occurredAt,
      data: {
        transactionId: state.transactionId,
        walletId: state.walletId,
        providerId: state.providerId,
        kind: state.kind,
        originalObservedBalance: state.balance,
      },
    });
  }
}

export interface WagerTransactionRejectedData extends Readonly<Record<string, unknown>> {
  readonly transactionId: string;
  readonly walletId: string;
  readonly providerId: string;
  readonly kind: PublicWagerKind;
  readonly failureCode: FailureCode;
  readonly originalObservedBalance: PublicMoney;
}

export class WagerTransactionRejectedEvent extends IntegrationEvent<
  'WagerTransactionRejected',
  WagerTransactionRejectedData
> {
  private constructor(
    state: Omit<
      IntegrationEventState<'WagerTransactionRejected', WagerTransactionRejectedData>,
      'eventType' | 'version'
    >,
  ) {
    super({ ...state, eventType: 'WagerTransactionRejected', version: 1 });
  }

  public static from(
    state: WagerEventIdentity & { readonly failureCode: FailureCode },
  ): WagerTransactionRejectedEvent {
    return new WagerTransactionRejectedEvent({
      eventId: state.eventId,
      aggregateId: state.walletId,
      correlationId: state.correlationId,
      ...(state.causationId === undefined ? {} : { causationId: state.causationId }),
      occurredAt: state.occurredAt,
      data: {
        transactionId: state.transactionId,
        walletId: state.walletId,
        providerId: state.providerId,
        kind: state.kind,
        failureCode: state.failureCode,
        originalObservedBalance: state.balance,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends Readonly<Record<string, unknown>> {
  readonly transactionId: string;
  readonly walletId: string;
  readonly providerId: string;
  readonly kind: 'REFUND' | 'ROLLBACK';
  readonly referenceExternalTransactionId: string;
  readonly retryExpiresAt: string;
}

export class WagerTransactionPendingReferenceEvent extends IntegrationEvent<
  'WagerTransactionPendingReference',
  WagerTransactionPendingReferenceData
> {
  private constructor(
    state: Omit<
      IntegrationEventState<
        'WagerTransactionPendingReference',
        WagerTransactionPendingReferenceData
      >,
      'eventType' | 'version'
    >,
  ) {
    super({ ...state, eventType: 'WagerTransactionPendingReference', version: 1 });
  }

  public static from(state: {
    readonly eventId: string;
    readonly transactionId: string;
    readonly walletId: string;
    readonly providerId: string;
    readonly kind: 'REFUND' | 'ROLLBACK';
    readonly referenceExternalTransactionId: string;
    readonly retryExpiresAt: Date;
    readonly correlationId: string;
    readonly causationId?: string;
    readonly occurredAt: Date;
  }): WagerTransactionPendingReferenceEvent {
    return new WagerTransactionPendingReferenceEvent({
      eventId: state.eventId,
      aggregateId: state.walletId,
      correlationId: state.correlationId,
      ...(state.causationId === undefined ? {} : { causationId: state.causationId }),
      occurredAt: state.occurredAt,
      data: {
        transactionId: state.transactionId,
        walletId: state.walletId,
        providerId: state.providerId,
        kind: state.kind,
        referenceExternalTransactionId: state.referenceExternalTransactionId,
        retryExpiresAt: state.retryExpiresAt.toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData extends Readonly<Record<string, unknown>> {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: PublicMoney;
  readonly balanceBefore: PublicMoney;
  readonly balanceAfter: PublicMoney;
  readonly walletVersion: number;
}

export class WalletBalanceChangedEvent extends IntegrationEvent<
  'WalletBalanceChanged',
  WalletBalanceChangedData
> {
  private constructor(
    state: Omit<
      IntegrationEventState<'WalletBalanceChanged', WalletBalanceChangedData>,
      'eventType' | 'version'
    >,
  ) {
    super({ ...state, eventType: 'WalletBalanceChanged', version: 1 });
  }

  public static from(state: {
    readonly eventId: string;
    readonly walletId: string;
    readonly transactionId: string;
    readonly direction: LedgerDirection;
    readonly money: PublicMoney;
    readonly balanceBefore: PublicMoney;
    readonly balanceAfter: PublicMoney;
    readonly walletVersion: number;
    readonly correlationId: string;
    readonly causationId?: string;
    readonly occurredAt: Date;
  }): WalletBalanceChangedEvent {
    return new WalletBalanceChangedEvent({
      eventId: state.eventId,
      aggregateId: state.walletId,
      correlationId: state.correlationId,
      ...(state.causationId === undefined ? {} : { causationId: state.causationId }),
      occurredAt: state.occurredAt,
      data: {
        walletId: state.walletId,
        transactionId: state.transactionId,
        direction: state.direction,
        money: state.money,
        balanceBefore: state.balanceBefore,
        balanceAfter: state.balanceAfter,
        walletVersion: state.walletVersion,
      },
    });
  }
}
