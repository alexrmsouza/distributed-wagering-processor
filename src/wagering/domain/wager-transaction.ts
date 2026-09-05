import { Entity } from '../../shared/domain/entity.js';
import { Money } from '../../shared/domain/money.js';
import { assertFailureCode, type FailureCode } from './failure-code.js';
import {
  InvalidWagerTransactionError,
  InvalidWagerTransactionStateError,
  TerminalWagerTransactionError,
} from './wager-transaction.errors.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REVERSAL_KINDS = new Set<WagerTransactionKind>(['REFUND', 'ROLLBACK']);
const TERMINAL_STATUSES = new Set<WagerTransactionStatus>(['PROCESSED', 'REJECTED', 'FAILED']);

const WAGER_TRANSACTION_KINDS = Object.freeze([
  'OPENING',
  'BET',
  'WIN',
  'LOSS',
  'REFUND',
  'ROLLBACK',
] as const);

const WAGER_TRANSACTION_STATUSES = Object.freeze([
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
] as const);

export type WagerTransactionKind = (typeof WAGER_TRANSACTION_KINDS)[number];
export type WagerTransactionStatus = (typeof WAGER_TRANSACTION_STATUSES)[number];

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly amount: Money;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly createdAt: Date;
}

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly observedBalanceMinor: bigint | null;
  readonly observedBalanceCurrency: string | null;
  readonly retryAttempts: number;
  readonly nextRetryAt: Date | null;
  readonly retryExpiresAt: Date | null;
  readonly processedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProcessWagerTransactionProps {
  readonly observedBalance: Money;
  readonly processedAt: Date;
}

export interface RejectWagerTransactionProps {
  readonly failureCode: FailureCode;
  readonly observedBalance: Money | null;
  readonly processedAt: Date;
}

export interface FailWagerTransactionProps {
  readonly observedBalance: Money | null;
  readonly processedAt: Date;
}

export interface MarkPendingReferenceProps {
  readonly retryAttempts: number;
  readonly nextRetryAt: Date;
  readonly retryExpiresAt: Date;
  readonly updatedAt: Date;
}

export interface ResolveWagerTransactionReferenceProps {
  readonly referenceTransactionId: string;
  readonly updatedAt: Date;
}

export class WagerTransaction extends Entity {
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly amount: Money;
  public readonly referenceExternalTransactionId: string | null;
  public readonly referenceTransactionId: string | null;
  public readonly status: WagerTransactionStatus;
  public readonly failureCode: FailureCode | null;
  public readonly observedBalance: Money | null;
  public readonly retryAttempts: number;
  readonly #nextRetryAtEpoch: number | null;
  readonly #retryExpiresAtEpoch: number | null;
  readonly #processedAtEpoch: number | null;
  readonly #createdAtEpoch: number;
  readonly #updatedAtEpoch: number;

  private constructor(state: WagerTransactionState) {
    super(state.id);
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.amount = Money.rehydrate({ amountMinor: state.amountMinor, currency: state.currency });
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.referenceTransactionId = state.referenceTransactionId;
    this.status = state.status;
    this.failureCode = state.failureCode;
    this.observedBalance =
      state.observedBalanceMinor === null
        ? null
        : Money.rehydrate({
            amountMinor: state.observedBalanceMinor,
            currency: state.observedBalanceCurrency ?? state.currency,
          });
    this.retryAttempts = state.retryAttempts;
    this.#nextRetryAtEpoch = state.nextRetryAt?.getTime() ?? null;
    this.#retryExpiresAtEpoch = state.retryExpiresAt?.getTime() ?? null;
    this.#processedAtEpoch = state.processedAt?.getTime() ?? null;
    this.#createdAtEpoch = state.createdAt.getTime();
    this.#updatedAtEpoch = state.updatedAt.getTime();
    Object.freeze(this);
  }

  public static create(props: CreateWagerTransactionProps): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      amountMinor: props.amount.amountMinor,
      currency: props.amount.currency,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      referenceTransactionId: props.referenceTransactionId,
      status: 'PENDING',
      failureCode: null,
      observedBalanceMinor: null,
      observedBalanceCurrency: null,
      retryAttempts: 0,
      nextRetryAt: null,
      retryExpiresAt: null,
      processedAt: null,
      createdAt: props.createdAt,
      updatedAt: props.createdAt,
    });
  }

  public static rehydrate(state: WagerTransactionState): WagerTransaction {
    WagerTransaction.assertIdentity(state);
    WagerTransaction.assertLifecycleState(state);

    return new WagerTransaction(state);
  }

  public get nextRetryAt(): Date | null {
    return WagerTransaction.toDate(this.#nextRetryAtEpoch);
  }

  public get retryExpiresAt(): Date | null {
    return WagerTransaction.toDate(this.#retryExpiresAtEpoch);
  }

  public get processedAt(): Date | null {
    return WagerTransaction.toDate(this.#processedAtEpoch);
  }

  public get createdAt(): Date {
    return new Date(this.#createdAtEpoch);
  }

  public get updatedAt(): Date {
    return new Date(this.#updatedAtEpoch);
  }

  public markPendingReference(props: MarkPendingReferenceProps): WagerTransaction {
    this.assertCanTransitionTo('PENDING_REFERENCE');
    if (!REVERSAL_KINDS.has(this.kind)) {
      throw new InvalidWagerTransactionError(
        'Only a reversal transaction may wait for a missing reference',
      );
    }
    this.assertTransitionTime(props.updatedAt);

    return WagerTransaction.rehydrate({
      ...this.toState(),
      status: 'PENDING_REFERENCE',
      retryAttempts: props.retryAttempts,
      nextRetryAt: props.nextRetryAt,
      retryExpiresAt: props.retryExpiresAt,
      updatedAt: props.updatedAt,
    });
  }

  public reschedulePendingReference(props: MarkPendingReferenceProps): WagerTransaction {
    if (this.status !== 'PENDING_REFERENCE') {
      throw new InvalidWagerTransactionStateError(this.status, 'PENDING_REFERENCE');
    }
    this.assertTransitionTime(props.updatedAt);

    return WagerTransaction.rehydrate({
      ...this.toState(),
      retryAttempts: props.retryAttempts,
      nextRetryAt: props.nextRetryAt,
      retryExpiresAt: props.retryExpiresAt,
      updatedAt: props.updatedAt,
    });
  }

  public resolveReference(props: ResolveWagerTransactionReferenceProps): WagerTransaction {
    if (
      !REVERSAL_KINDS.has(this.kind) ||
      (this.status !== 'PENDING' && this.status !== 'PENDING_REFERENCE') ||
      !WagerTransaction.isNormalized(props.referenceTransactionId)
    ) {
      throw new InvalidWagerTransactionError(
        'Only a pending reversal may resolve a normalized reference',
      );
    }
    if (
      this.referenceTransactionId !== null &&
      this.referenceTransactionId !== props.referenceTransactionId
    ) {
      throw new InvalidWagerTransactionError('Wager transaction reference cannot be replaced');
    }
    this.assertTransitionTime(props.updatedAt);

    return WagerTransaction.rehydrate({
      ...this.toState(),
      referenceTransactionId: props.referenceTransactionId,
      updatedAt: props.updatedAt,
    });
  }

  public process(props: ProcessWagerTransactionProps): WagerTransaction {
    this.assertCanTransitionTo('PROCESSED');
    if (props.observedBalance.currency !== this.amount.currency) {
      throw new InvalidWagerTransactionError(
        'Processed Wager transaction balance currency must match its amount',
      );
    }
    this.assertTransitionTime(props.processedAt);

    return this.complete('PROCESSED', null, props.observedBalance, props.processedAt);
  }

  public reject(props: RejectWagerTransactionProps): WagerTransaction {
    this.assertCanTransitionTo('REJECTED');
    assertFailureCode(props.failureCode);
    this.assertTransitionTime(props.processedAt);

    return this.complete('REJECTED', props.failureCode, props.observedBalance, props.processedAt);
  }

  public failForPermanentInfrastructure(props: FailWagerTransactionProps): WagerTransaction {
    this.assertCanTransitionTo('FAILED');
    this.assertTransitionTime(props.processedAt);

    return this.complete('FAILED', null, props.observedBalance, props.processedAt);
  }

  public toState(): WagerTransactionState {
    return Object.freeze({
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      amountMinor: this.amount.amountMinor,
      currency: this.amount.currency,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      referenceTransactionId: this.referenceTransactionId,
      status: this.status,
      failureCode: this.failureCode,
      observedBalanceMinor: this.observedBalance?.amountMinor ?? null,
      observedBalanceCurrency: this.observedBalance?.currency ?? null,
      retryAttempts: this.retryAttempts,
      nextRetryAt: this.nextRetryAt,
      retryExpiresAt: this.retryExpiresAt,
      processedAt: this.processedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    });
  }

  private static assertIdentity(state: WagerTransactionState): void {
    const normalizedFields = [
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
    ];

    if (normalizedFields.some((value) => value.length === 0 || value.trim() !== value)) {
      throw new InvalidWagerTransactionError(
        'Wager transaction business identifiers must be normalized',
      );
    }
    if (!HASH_PATTERN.test(state.payloadHash)) {
      throw new InvalidWagerTransactionError('Wager transaction payload hash must be SHA-256');
    }
    if (!(WAGER_TRANSACTION_KINDS as readonly string[]).includes(state.kind)) {
      throw new InvalidWagerTransactionError('Wager transaction kind is not supported');
    }
    if (state.amountMinor <= 0n) {
      throw new InvalidWagerTransactionError('Wager transaction amount must be positive');
    }

    const isReversal = REVERSAL_KINDS.has(state.kind);
    const hasExternalReference = state.referenceExternalTransactionId !== null;
    const hasInternalReference = state.referenceTransactionId !== null;

    if (
      (isReversal && !hasExternalReference) ||
      (!isReversal && (hasExternalReference || hasInternalReference))
    ) {
      throw new InvalidWagerTransactionError(
        'Wager transaction reference must match its transaction kind',
      );
    }

    if (
      (state.referenceExternalTransactionId !== null &&
        !WagerTransaction.isNormalized(state.referenceExternalTransactionId)) ||
      (state.referenceTransactionId !== null &&
        !WagerTransaction.isNormalized(state.referenceTransactionId))
    ) {
      throw new InvalidWagerTransactionError('Wager transaction reference must be normalized');
    }
  }

  private static assertLifecycleState(state: WagerTransactionState): void {
    if (!(WAGER_TRANSACTION_STATUSES as readonly string[]).includes(state.status)) {
      throw new InvalidWagerTransactionError('Wager transaction status is not supported');
    }
    if (state.failureCode !== null) {
      assertFailureCode(state.failureCode);
    }
    if (!Number.isInteger(state.retryAttempts) || state.retryAttempts < 0) {
      throw new InvalidWagerTransactionError('Wager transaction retry attempts must be valid');
    }

    const createdAt = WagerTransaction.assertDate(state.createdAt, 'created');
    const updatedAt = WagerTransaction.assertDate(state.updatedAt, 'updated');
    const processedAt = WagerTransaction.optionalDateEpoch(state.processedAt, 'processed');
    const nextRetryAt = WagerTransaction.optionalDateEpoch(state.nextRetryAt, 'next retry');
    const retryExpiresAt = WagerTransaction.optionalDateEpoch(
      state.retryExpiresAt,
      'retry expiration',
    );

    if (updatedAt < createdAt || (processedAt !== null && processedAt < createdAt)) {
      throw new InvalidWagerTransactionError('Wager transaction timestamps must be ordered');
    }

    const hasRetrySchedule = nextRetryAt !== null && retryExpiresAt !== null;
    const hasNoRetrySchedule = nextRetryAt === null && retryExpiresAt === null;
    const isPendingReference = state.status === 'PENDING_REFERENCE';

    if (
      (isPendingReference &&
        (!hasRetrySchedule || retryExpiresAt <= createdAt || nextRetryAt > retryExpiresAt)) ||
      (!isPendingReference && !hasNoRetrySchedule)
    ) {
      throw new InvalidWagerTransactionError(
        'Wager transaction retry schedule must match its status',
      );
    }

    if ((state.observedBalanceMinor === null) !== (state.observedBalanceCurrency === null)) {
      throw new InvalidWagerTransactionError(
        'Observed balance amount and currency must be stored together',
      );
    }

    if (state.status === 'PENDING' || state.status === 'PENDING_REFERENCE') {
      if (
        state.failureCode !== null ||
        state.observedBalanceMinor !== null ||
        state.observedBalanceCurrency !== null ||
        state.processedAt !== null
      ) {
        throw new InvalidWagerTransactionError(
          'Non-terminal Wager transaction cannot contain a terminal outcome',
        );
      }

      return;
    }

    if (state.processedAt === null) {
      throw new InvalidWagerTransactionError(
        'Terminal Wager transaction must have a completion timestamp',
      );
    }
    if (
      state.status === 'PROCESSED' &&
      (state.observedBalanceMinor === null || state.observedBalanceCurrency !== state.currency)
    ) {
      throw new InvalidWagerTransactionError(
        'Processed Wager transaction must retain its observed balance',
      );
    }
    if (state.status === 'REJECTED' && state.failureCode === null) {
      throw new InvalidWagerTransactionError(
        'Rejected Wager transaction must contain a stable failure code',
      );
    }
    if (state.status !== 'REJECTED' && state.failureCode !== null) {
      throw new InvalidWagerTransactionError(
        'Only rejected Wager transactions may contain a business failure code',
      );
    }
  }

  private static assertDate(value: Date, label: string): number {
    const epoch = value.getTime();

    if (!Number.isFinite(epoch)) {
      throw new InvalidWagerTransactionError(`Wager transaction ${label} timestamp must be valid`);
    }

    return epoch;
  }

  private static optionalDateEpoch(value: Date | null, label: string): number | null {
    return value === null ? null : WagerTransaction.assertDate(value, label);
  }

  private static isNormalized(value: string): boolean {
    return value.length > 0 && value.trim() === value;
  }

  private static toDate(epoch: number | null): Date | null {
    return epoch === null ? null : new Date(epoch);
  }

  private assertCanTransitionTo(targetStatus: WagerTransactionStatus): void {
    if (TERMINAL_STATUSES.has(this.status)) {
      throw new TerminalWagerTransactionError(this.status);
    }

    const allowed =
      this.status === 'PENDING'
        ? targetStatus !== 'PENDING'
        : targetStatus === 'PROCESSED' || targetStatus === 'REJECTED';

    if (!allowed) {
      throw new InvalidWagerTransactionStateError(this.status, targetStatus);
    }
  }

  private assertTransitionTime(at: Date): void {
    const epoch = WagerTransaction.assertDate(at, 'transition');

    if (epoch < this.#updatedAtEpoch) {
      throw new InvalidWagerTransactionError(
        'Wager transaction transition cannot precede its latest update',
      );
    }
  }

  private complete(
    status: 'PROCESSED' | 'REJECTED' | 'FAILED',
    failureCode: FailureCode | null,
    observedBalance: Money | null,
    processedAt: Date,
  ): WagerTransaction {
    return WagerTransaction.rehydrate({
      ...this.toState(),
      status,
      failureCode,
      observedBalanceMinor: observedBalance?.amountMinor ?? null,
      observedBalanceCurrency: observedBalance?.currency ?? null,
      nextRetryAt: null,
      retryExpiresAt: null,
      processedAt,
      updatedAt: processedAt,
    });
  }
}
