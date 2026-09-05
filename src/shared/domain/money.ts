import {
  CurrencyMismatchError,
  InsufficientMoneyError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
} from './money.errors.js';

const PUBLIC_AMOUNT_PATTERN = /^(\d+)\.(\d{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MINOR_UNIT_SCALE = 100n;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

export interface PublicMoney {
  readonly amount: string;
  readonly currency: string;
}

export interface PersistedMoney {
  readonly amountMinor: bigint;
  readonly currency: string;
}

export class Money {
  private constructor(
    public readonly amountMinor: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  public static create(input: PublicMoney): Money {
    const amountMinor = Money.parsePublicAmount(input.amount);
    Money.assertCurrency(input.currency);

    return new Money(amountMinor, input.currency);
  }

  public static rehydrate(state: PersistedMoney): Money {
    Money.assertMinorUnits(state.amountMinor);
    Money.assertCurrency(state.currency);

    return new Money(state.amountMinor, state.currency);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.rehydrate({
      amountMinor: this.amountMinor + other.amountMinor,
      currency: this.currency,
    });
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);

    if (other.amountMinor > this.amountMinor) {
      throw new InsufficientMoneyError();
    }

    return Money.rehydrate({
      amountMinor: this.amountMinor - other.amountMinor,
      currency: this.currency,
    });
  }

  public compareTo(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);

    if (this.amountMinor < other.amountMinor) {
      return -1;
    }

    if (this.amountMinor > other.amountMinor) {
      return 1;
    }

    return 0;
  }

  public equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  public toJSON(): PublicMoney {
    return Object.freeze({
      amount: Money.formatPublicAmount(this.amountMinor),
      currency: this.currency,
    });
  }

  public toString(): string {
    return `${Money.formatPublicAmount(this.amountMinor)} ${this.currency}`;
  }

  private static parsePublicAmount(amount: string): bigint {
    const match = PUBLIC_AMOUNT_PATTERN.exec(amount);
    const integralDigits = match?.[1];
    const fractionalDigits = match?.[2];

    if (integralDigits === undefined || fractionalDigits === undefined) {
      throw new InvalidMoneyAmountError();
    }

    const amountMinor = BigInt(integralDigits) * MINOR_UNIT_SCALE + BigInt(fractionalDigits);
    Money.assertMinorUnits(amountMinor);

    return amountMinor;
  }

  private static formatPublicAmount(amountMinor: bigint): string {
    const integralDigits = amountMinor / MINOR_UNIT_SCALE;
    const fractionalDigits = (amountMinor % MINOR_UNIT_SCALE).toString().padStart(2, '0');

    return `${integralDigits.toString()}.${fractionalDigits}`;
  }

  private static assertMinorUnits(amountMinor: bigint): void {
    if (typeof amountMinor !== 'bigint' || amountMinor < 0n || amountMinor > MAX_SIGNED_BIGINT) {
      throw new InvalidMoneyAmountError();
    }
  }

  private static assertCurrency(currency: string): void {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidCurrencyError();
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
