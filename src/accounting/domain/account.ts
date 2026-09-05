import { Entity } from '../../shared/domain/entity.js';

export const AccountKind = {
  PlayerBalance: 'PLAYER_BALANCE',
  ProviderClearing: 'PROVIDER_CLEARING',
  InternalFunding: 'INTERNAL_FUNDING',
} as const;

export type AccountKind = (typeof AccountKind)[keyof typeof AccountKind];

export interface AccountState {
  readonly id: string;
  readonly kind: AccountKind;
  readonly ownerId: string;
  readonly currency: string;
  readonly createdAt: Date;
}

export class Account extends Entity {
  public readonly kind: AccountKind;
  public readonly ownerId: string;
  public readonly currency: string;
  readonly #createdAtEpoch: number;

  private constructor(state: AccountState) {
    super(state.id);
    this.kind = state.kind;
    this.ownerId = state.ownerId;
    this.currency = state.currency;
    this.#createdAtEpoch = state.createdAt.getTime();
    Object.freeze(this);
  }

  public static create(state: AccountState): Account {
    return Account.rehydrate(state);
  }

  public static rehydrate(state: AccountState): Account {
    if (
      !Object.values(AccountKind).includes(state.kind) ||
      state.ownerId.trim().length === 0 ||
      !/^[A-Z]{3}$/.test(state.currency) ||
      !Number.isFinite(state.createdAt.getTime())
    ) {
      throw new TypeError('Account state is invalid');
    }

    return new Account(state);
  }

  public get createdAt(): Date {
    return new Date(this.#createdAtEpoch);
  }

  public toState(): AccountState {
    return Object.freeze({
      id: this.id,
      kind: this.kind,
      ownerId: this.ownerId,
      currency: this.currency,
      createdAt: this.createdAt,
    });
  }
}
