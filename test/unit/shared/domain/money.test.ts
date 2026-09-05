import { describe, expect, test } from 'bun:test';

import {
  CurrencyMismatchError,
  InsufficientMoneyError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
} from '../../../../src/shared/domain/money.errors.js';
import { Money } from '../../../../src/shared/domain/money.js';

describe('Money', () => {
  describe('create', () => {
    test('creates an immutable exact amount from a public representation', () => {
      const money = Money.create({ amount: '92233720368547758.07', currency: 'BRL' });

      expect(money.amountMinor).toBe(9_223_372_036_854_775_807n);
      expect(money.currency).toBe('BRL');
      expect(Object.isFrozen(money)).toBe(true);
    });

    test.each([
      '',
      '0',
      '0.0',
      '0.000',
      '.00',
      ' 1.00',
      '1.00 ',
      '-1.00',
      '+1.00',
      '1e2',
      'Infinity',
      'NaN',
      '92233720368547758.08',
    ])('rejects the invalid public amount %p', (amount) => {
      expect(() => Money.create({ amount, currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
    });

    test.each(['brl', 'Brl', 'BR', 'BRLL', '123', ' BRL', 'BRL '])(
      'rejects the invalid currency %p',
      (currency) => {
        expect(() => Money.create({ amount: '1.00', currency })).toThrow(InvalidCurrencyError);
      },
    );
  });

  describe('rehydrate', () => {
    test('restores an exact amount from bigint minor units', () => {
      const money = Money.rehydrate({ amountMinor: 9_007_199_254_740_993n, currency: 'USD' });

      expect(money.amountMinor).toBe(9_007_199_254_740_993n);
      expect(money.toString()).toBe('90071992547409.93 USD');
    });

    test('rejects negative minor units', () => {
      expect(() => Money.rehydrate({ amountMinor: -1n, currency: 'BRL' })).toThrow(
        InvalidMoneyAmountError,
      );
    });

    test('rejects non-bigint minor units at runtime', () => {
      expect(() =>
        Money.rehydrate({ amountMinor: 100 as unknown as bigint, currency: 'BRL' }),
      ).toThrow(InvalidMoneyAmountError);
    });
  });

  describe('arithmetic', () => {
    test('adds exact bigint minor units without precision loss', () => {
      const left = Money.create({ amount: '90071992547409.93', currency: 'BRL' });
      const right = Money.create({ amount: '0.07', currency: 'BRL' });

      expect(left.add(right).amountMinor).toBe(9_007_199_254_741_000n);
    });

    test('subtracts when sufficient funds exist', () => {
      const balance = Money.create({ amount: '100.00', currency: 'BRL' });

      expect(balance.subtract(Money.create({ amount: '80.00', currency: 'BRL' }))).toEqual(
        Money.create({ amount: '20.00', currency: 'BRL' }),
      );
    });

    test('rejects subtraction that would produce a negative amount', () => {
      const balance = Money.create({ amount: '20.00', currency: 'BRL' });

      expect(() => balance.subtract(Money.create({ amount: '20.01', currency: 'BRL' }))).toThrow(
        InsufficientMoneyError,
      );
    });

    test('rejects arithmetic across currencies', () => {
      const brl = Money.create({ amount: '1.00', currency: 'BRL' });
      const usd = Money.create({ amount: '1.00', currency: 'USD' });

      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe('comparison and serialization', () => {
    test('compares and checks equality using amount and currency', () => {
      const lower = Money.create({ amount: '10.00', currency: 'BRL' });
      const equal = Money.rehydrate({ amountMinor: 1_000n, currency: 'BRL' });
      const higher = Money.create({ amount: '10.01', currency: 'BRL' });

      expect(lower.compareTo(higher)).toBe(-1);
      expect(higher.compareTo(lower)).toBe(1);
      expect(lower.compareTo(equal)).toBe(0);
      expect(lower.equals(equal)).toBe(true);
      expect(lower.equals(Money.create({ amount: '10.00', currency: 'USD' }))).toBe(false);
    });

    test('rejects comparison across currencies', () => {
      const brl = Money.create({ amount: '1.00', currency: 'BRL' });
      const usd = Money.create({ amount: '1.00', currency: 'USD' });

      expect(() => brl.compareTo(usd)).toThrow(CurrencyMismatchError);
    });

    test('serializes safely as an exact public money object', () => {
      const money = Money.rehydrate({
        amountMinor: 9_223_372_036_854_775_807n,
        currency: 'BRL',
      });

      expect(money.toJSON()).toEqual({
        amount: '92233720368547758.07',
        currency: 'BRL',
      });
      expect(JSON.stringify(money)).toBe('{"amount":"92233720368547758.07","currency":"BRL"}');
      expect(money.toString()).toBe('92233720368547758.07 BRL');
    });
  });
});
