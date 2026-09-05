import { DomainError } from './domain-error.js';

export class InvalidMoneyAmountError extends DomainError<'INVALID_PAYLOAD'> {
  public constructor() {
    super(
      'INVALID_PAYLOAD',
      'Money amount must be a supported non-negative decimal string with exactly two fractional digits',
    );
  }
}

export class InvalidCurrencyError extends DomainError<'INVALID_PAYLOAD'> {
  public constructor() {
    super('INVALID_PAYLOAD', 'Currency must be an uppercase ISO-4217 code');
  }
}

export class CurrencyMismatchError extends DomainError<'CURRENCY_MISMATCH'> {
  public constructor(
    public readonly expectedCurrency: string,
    public readonly actualCurrency: string,
  ) {
    super('CURRENCY_MISMATCH', 'Money currencies must match');
  }
}

export class InsufficientMoneyError extends DomainError<'INSUFFICIENT_FUNDS'> {
  public constructor() {
    super('INSUFFICIENT_FUNDS', 'Money subtraction cannot produce a negative amount');
  }
}
