import { DomainError } from '../../shared/domain/domain-error.js';
import { Entity } from '../../shared/domain/entity.js';
import type { Money } from '../../shared/domain/money.js';
import type { AccountingPosting } from './accounting-posting.js';

export class InvalidAccountingJournalError extends DomainError<'INVALID_PAYLOAD'> {
  public constructor(message = 'Accounting journal must contain one debit and one credit') {
    super('INVALID_PAYLOAD', message);
  }
}

export class UnbalancedAccountingJournalError extends DomainError<'INVALID_PAYLOAD'> {
  public constructor() {
    super('INVALID_PAYLOAD', 'Accounting journal debit and credit totals must be equal');
  }
}

export interface AccountingJournalState {
  readonly id: string;
  readonly transactionId: string;
  readonly walletId: string;
  readonly postings: readonly AccountingPosting[];
  readonly createdAt: Date;
}

export class AccountingJournal extends Entity {
  public readonly transactionId: string;
  public readonly walletId: string;
  public readonly postings: readonly AccountingPosting[];
  public readonly debitTotal: Money;
  public readonly creditTotal: Money;
  readonly #createdAtEpoch: number;

  private constructor(state: AccountingJournalState) {
    super(state.id);
    this.transactionId = state.transactionId;
    this.walletId = state.walletId;
    this.postings = Object.freeze([...state.postings]);
    const debit = this.postings.find(({ direction }) => direction === 'DEBIT');
    const credit = this.postings.find(({ direction }) => direction === 'CREDIT');

    if (debit === undefined || credit === undefined) {
      throw new InvalidAccountingJournalError();
    }

    this.debitTotal = debit.amount;
    this.creditTotal = credit.amount;
    this.#createdAtEpoch = state.createdAt.getTime();
    Object.freeze(this);
  }

  public static create(state: AccountingJournalState): AccountingJournal {
    return AccountingJournal.rehydrate(state);
  }

  public static rehydrate(state: AccountingJournalState): AccountingJournal {
    const debits = state.postings.filter(({ direction }) => direction === 'DEBIT');
    const credits = state.postings.filter(({ direction }) => direction === 'CREDIT');

    if (
      state.postings.length !== 2 ||
      debits.length !== 1 ||
      credits.length !== 1 ||
      state.postings.some(({ journalId }) => journalId !== state.id) ||
      new Set(state.postings.map(({ accountId }) => accountId).values()).size !== 2 ||
      !Number.isFinite(state.createdAt.getTime())
    ) {
      throw new InvalidAccountingJournalError();
    }

    const debit = debits[0];
    const credit = credits[0];
    if (debit === undefined) {
      throw new InvalidAccountingJournalError();
    }
    if (credit === undefined) {
      throw new InvalidAccountingJournalError();
    }
    if (debit.amount.currency !== credit.amount.currency) {
      throw new InvalidAccountingJournalError('Accounting postings must use the same currency');
    }
    if (!debit.amount.equals(credit.amount)) {
      throw new UnbalancedAccountingJournalError();
    }

    return new AccountingJournal(state);
  }

  public get createdAt(): Date {
    return new Date(this.#createdAtEpoch);
  }

  public isBalanced(): boolean {
    return this.debitTotal.equals(this.creditTotal);
  }
}
