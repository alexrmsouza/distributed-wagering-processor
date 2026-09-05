import { Entity } from '../../shared/domain/entity.js';
import { Money } from '../../shared/domain/money.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface CreateWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly openingBalance: Money;
  readonly createdAt: Date;
}

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly balanceMinor: bigint;
  readonly currency: string;
  readonly version: bigint;
  readonly ledgerSequence: bigint;
  readonly lastLedgerHash: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class Wallet extends Entity {
  public readonly playerId: string;
  public readonly balance: Money;
  public readonly currency: string;
  public readonly version: bigint;
  public readonly ledgerSequence: bigint;
  public readonly lastLedgerHash: string | null;
  readonly #createdAtEpoch: number;
  readonly #updatedAtEpoch: number;

  private constructor(state: WalletState) {
    super(state.id);
    this.playerId = state.playerId;
    this.balance = Money.rehydrate({
      amountMinor: state.balanceMinor,
      currency: state.currency,
    });
    this.currency = state.currency;
    this.version = state.version;
    this.ledgerSequence = state.ledgerSequence;
    this.lastLedgerHash = state.lastLedgerHash;
    this.#createdAtEpoch = state.createdAt.getTime();
    this.#updatedAtEpoch = state.updatedAt.getTime();
    Object.freeze(this);
  }

  public static create(props: CreateWalletProps): Wallet {
    return Wallet.rehydrate({
      id: props.id,
      playerId: props.playerId,
      balanceMinor: props.openingBalance.amountMinor,
      currency: props.openingBalance.currency,
      version: 1n,
      ledgerSequence: 0n,
      lastLedgerHash: null,
      createdAt: props.createdAt,
      updatedAt: props.createdAt,
    });
  }

  public static rehydrate(state: WalletState): Wallet {
    if (state.playerId.trim().length === 0 || state.playerId.trim() !== state.playerId) {
      throw new TypeError('Wallet player identifier must be normalized');
    }
    if (state.version < 1n || state.ledgerSequence < 0n) {
      throw new TypeError('Wallet version and ledger sequence must be valid');
    }
    if (
      (state.ledgerSequence === 0n && state.lastLedgerHash !== null) ||
      (state.ledgerSequence > 0n && !HASH_PATTERN.test(state.lastLedgerHash ?? ''))
    ) {
      throw new TypeError('Wallet ledger head must match its sequence');
    }
    if (
      !Number.isFinite(state.createdAt.getTime()) ||
      !Number.isFinite(state.updatedAt.getTime()) ||
      state.updatedAt.getTime() < state.createdAt.getTime()
    ) {
      throw new TypeError('Wallet timestamps must be valid and ordered');
    }

    return new Wallet(state);
  }

  public get createdAt(): Date {
    return new Date(this.#createdAtEpoch);
  }

  public get updatedAt(): Date {
    return new Date(this.#updatedAtEpoch);
  }

  public credit(amount: Money, at: Date): Wallet {
    const balance = this.balance.add(amount);

    if (amount.amountMinor === 0n) {
      return this;
    }

    return this.withBalance(balance, at);
  }

  public debit(amount: Money, at: Date): Wallet {
    const balance = this.balance.subtract(amount);

    if (amount.amountMinor === 0n) {
      return this;
    }

    return this.withBalance(balance, at);
  }

  public withLedgerHead(entrySequence: bigint, entryHash: string): Wallet {
    if (entrySequence !== this.ledgerSequence + 1n || !HASH_PATTERN.test(entryHash)) {
      throw new TypeError('Wallet ledger head must advance by one valid entry');
    }

    return Wallet.rehydrate({
      ...this.toState(),
      ledgerSequence: entrySequence,
      lastLedgerHash: entryHash,
    });
  }

  public toState(): WalletState {
    return Object.freeze({
      id: this.id,
      playerId: this.playerId,
      balanceMinor: this.balance.amountMinor,
      currency: this.currency,
      version: this.version,
      ledgerSequence: this.ledgerSequence,
      lastLedgerHash: this.lastLedgerHash,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    });
  }

  private withBalance(balance: Money, at: Date): Wallet {
    return Wallet.rehydrate({
      ...this.toState(),
      balanceMinor: balance.amountMinor,
      version: this.version + 1n,
      updatedAt: at,
    });
  }
}
