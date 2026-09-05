import { DomainError } from '../../shared/domain/domain-error.js';
import { Entity } from '../../shared/domain/entity.js';
import { Money } from '../../shared/domain/money.js';
import {
  LedgerHashChain,
  type LedgerDirection,
  type LedgerHashInput,
} from './ledger-hash-chain.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class InvalidLedgerEntryError extends DomainError<'INVALID_PAYLOAD'> {
  public constructor(message = 'Ledger entry violates an immutable financial invariant') {
    super('INVALID_PAYLOAD', message);
  }
}

export interface CreateWalletLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly entrySequence: bigint;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly previousEntryHash: string | null;
  readonly createdAt: Date;
}

export interface WalletLedgerEntryState extends LedgerHashInput {
  readonly id: string;
  readonly entryHash: string;
}

export class WalletLedgerEntry extends Entity {
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly entrySequence: bigint;
  public readonly direction: LedgerDirection;
  public readonly amount: Money;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;
  public readonly previousEntryHash: string | null;
  public readonly entryHash: string;
  readonly #createdAtEpoch: number;

  private constructor(state: WalletLedgerEntryState) {
    super(state.id);
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.entrySequence = state.entrySequence;
    this.direction = state.direction;
    this.amount = Money.rehydrate({ amountMinor: state.amountMinor, currency: state.currency });
    this.balanceBefore = Money.rehydrate({
      amountMinor: state.balanceBeforeMinor,
      currency: state.currency,
    });
    this.balanceAfter = Money.rehydrate({
      amountMinor: state.balanceAfterMinor,
      currency: state.currency,
    });
    this.previousEntryHash = state.previousEntryHash;
    this.entryHash = state.entryHash;
    this.#createdAtEpoch = state.createdAt.getTime();
    Object.freeze(this);
  }

  public static create(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    if (props.amount.amountMinor === 0n) {
      throw new InvalidLedgerEntryError('Ledger entry amount must be positive');
    }

    const balanceAfter =
      props.direction === 'CREDIT'
        ? props.balanceBefore.add(props.amount)
        : props.balanceBefore.subtract(props.amount);
    const state: Omit<WalletLedgerEntryState, 'entryHash'> = {
      id: props.id,
      walletId: props.walletId,
      transactionId: props.transactionId,
      entrySequence: props.entrySequence,
      direction: props.direction,
      amountMinor: props.amount.amountMinor,
      currency: props.amount.currency,
      balanceBeforeMinor: props.balanceBefore.amountMinor,
      balanceAfterMinor: balanceAfter.amountMinor,
      previousEntryHash: props.previousEntryHash,
      createdAt: props.createdAt,
    };

    return WalletLedgerEntry.rehydrate({
      ...state,
      entryHash: LedgerHashChain.calculate(state),
    });
  }

  public static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    if (
      state.entrySequence < 1n ||
      (state.entrySequence === 1n && state.previousEntryHash !== null) ||
      (state.entrySequence > 1n && !HASH_PATTERN.test(state.previousEntryHash ?? '')) ||
      !HASH_PATTERN.test(state.entryHash) ||
      !Number.isFinite(state.createdAt.getTime())
    ) {
      throw new InvalidLedgerEntryError();
    }

    const amount = Money.rehydrate({ amountMinor: state.amountMinor, currency: state.currency });
    const before = Money.rehydrate({
      amountMinor: state.balanceBeforeMinor,
      currency: state.currency,
    });

    if (amount.amountMinor === 0n || (state.entrySequence === 1n && before.amountMinor !== 0n)) {
      throw new InvalidLedgerEntryError();
    }

    const expectedAfter =
      state.direction === 'CREDIT' ? before.add(amount) : before.subtract(amount);
    if (expectedAfter.amountMinor !== state.balanceAfterMinor) {
      throw new InvalidLedgerEntryError();
    }

    return new WalletLedgerEntry(state);
  }

  public get createdAt(): Date {
    return new Date(this.#createdAtEpoch);
  }

  public isBalanced(): boolean {
    return true;
  }

  public hasValidHash(): boolean {
    return LedgerHashChain.calculate(this.toHashInput()) === this.entryHash;
  }

  public toState(): WalletLedgerEntryState {
    return Object.freeze({
      id: this.id,
      ...this.toHashInput(),
      entryHash: this.entryHash,
    });
  }

  private toHashInput(): LedgerHashInput {
    return {
      walletId: this.walletId,
      transactionId: this.transactionId,
      entrySequence: this.entrySequence,
      direction: this.direction,
      amountMinor: this.amount.amountMinor,
      currency: this.amount.currency,
      balanceBeforeMinor: this.balanceBefore.amountMinor,
      balanceAfterMinor: this.balanceAfter.amountMinor,
      previousEntryHash: this.previousEntryHash,
      createdAt: this.createdAt,
    };
  }
}
