import { describe, expect, test } from 'bun:test';

import { CurrencyMismatchError } from '../../../../src/shared/domain/money.errors.js';
import { Money } from '../../../../src/shared/domain/money.js';

const CREATED_AT = new Date('2026-09-04T12:00:00.000Z');

async function openWallet(amount = '100.00', currency = 'BRL') {
  const { Wallet } = await import('../../../../src/wallet/domain/wallet.js');

  return Wallet.create({
    id: '01991a20-7b40-7000-8000-000000000001',
    playerId: '01991a20-7b40-7000-8000-000000000002',
    openingBalance: Money.create({ amount, currency }),
    createdAt: CREATED_AT,
  });
}

describe('Wallet', () => {
  test('opens with the exact balance and version one', async () => {
    const wallet = await openWallet('92233720368547758.07');

    expect(wallet.id).toBe('01991a20-7b40-7000-8000-000000000001');
    expect(wallet.playerId).toBe('01991a20-7b40-7000-8000-000000000002');
    expect(wallet.balance.amountMinor).toBe(9_223_372_036_854_775_807n);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1n);
    expect(wallet.createdAt).toEqual(CREATED_AT);
    expect(wallet.updatedAt).toEqual(CREATED_AT);
    expect(Object.isFrozen(wallet)).toBe(true);
  });

  test('returns a new version only when the balance changes', async () => {
    const wallet = await openWallet();
    const unchanged = wallet.credit(Money.create({ amount: '0.00', currency: 'BRL' }), CREATED_AT);
    const credited = wallet.credit(
      Money.create({ amount: '5.00', currency: 'BRL' }),
      new Date('2026-09-04T12:01:00.000Z'),
    );

    expect(unchanged).toBe(wallet);
    expect(credited).not.toBe(wallet);
    expect(credited.balance.toJSON()).toEqual({ amount: '105.00', currency: 'BRL' });
    expect(credited.version).toBe(2n);
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.version).toBe(1n);
  });

  test('rejects movements in a different currency', async () => {
    const wallet = await openWallet();
    const usd = Money.create({ amount: '1.00', currency: 'USD' });

    expect(() => wallet.credit(usd, CREATED_AT)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd, CREATED_AT)).toThrow(CurrencyMismatchError);
  });

  test('rehydrates persistence state without changing its version or timestamps', async () => {
    const { Wallet } = await import('../../../../src/wallet/domain/wallet.js');
    const updatedAt = new Date('2026-09-04T12:05:00.000Z');
    const wallet = Wallet.rehydrate({
      id: '01991a20-7b40-7000-8000-000000000003',
      playerId: '01991a20-7b40-7000-8000-000000000004',
      balanceMinor: 2_500n,
      currency: 'USD',
      version: 7n,
      ledgerSequence: 3n,
      lastLedgerHash: 'a'.repeat(64),
      createdAt: CREATED_AT,
      updatedAt,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '25.00', currency: 'USD' });
    expect(wallet.version).toBe(7n);
    expect(wallet.ledgerSequence).toBe(3n);
    expect(wallet.lastLedgerHash).toBe('a'.repeat(64));
    expect(wallet.createdAt).toEqual(CREATED_AT);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });
});
