import { Entity } from '../../shared/domain/entity.js';
import { Money } from '../../shared/domain/money.js';

export type PostingDirection = 'DEBIT' | 'CREDIT';

export interface CreateAccountingPostingProps {
  readonly id: string;
  readonly journalId: string;
  readonly accountId: string;
  readonly direction: PostingDirection;
  readonly amount: Money;
  readonly createdAt: Date;
}

export interface AccountingPostingState {
  readonly id: string;
  readonly journalId: string;
  readonly accountId: string;
  readonly direction: PostingDirection;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly createdAt: Date;
}

export class AccountingPosting extends Entity {
  public readonly journalId: string;
  public readonly accountId: string;
  public readonly direction: PostingDirection;
  public readonly amount: Money;
  readonly #createdAtEpoch: number;

  private constructor(state: AccountingPostingState) {
    super(state.id);
    this.journalId = state.journalId;
    this.accountId = state.accountId;
    this.direction = state.direction;
    this.amount = Money.rehydrate({ amountMinor: state.amountMinor, currency: state.currency });
    this.#createdAtEpoch = state.createdAt.getTime();
    Object.freeze(this);
  }

  public static create(props: CreateAccountingPostingProps): AccountingPosting {
    return AccountingPosting.rehydrate({
      id: props.id,
      journalId: props.journalId,
      accountId: props.accountId,
      direction: props.direction,
      amountMinor: props.amount.amountMinor,
      currency: props.amount.currency,
      createdAt: props.createdAt,
    });
  }

  public static rehydrate(state: AccountingPostingState): AccountingPosting {
    if (
      !['DEBIT', 'CREDIT'].includes(state.direction) ||
      state.amountMinor <= 0n ||
      !Number.isFinite(state.createdAt.getTime())
    ) {
      throw new TypeError('Accounting posting state is invalid');
    }

    return new AccountingPosting(state);
  }

  public get createdAt(): Date {
    return new Date(this.#createdAtEpoch);
  }

  public toState(): AccountingPostingState {
    return Object.freeze({
      id: this.id,
      journalId: this.journalId,
      accountId: this.accountId,
      direction: this.direction,
      amountMinor: this.amount.amountMinor,
      currency: this.amount.currency,
      createdAt: this.createdAt,
    });
  }
}
