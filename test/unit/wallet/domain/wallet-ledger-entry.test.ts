import { describe, expect, test } from 'bun:test';

import {
  CurrencyMismatchError,
  InsufficientMoneyError,
} from '../../../../src/shared/domain/money.errors.js';
import { Money } from '../../../../src/shared/domain/money.js';

const CREATED_AT = new Date('2026-09-04T12:00:00.000Z');

async function loadLedgerEntry() {
  return import('../../../../src/wallet/domain/wallet-ledger-entry.js');
}

function baseInput() {
  return {
    id: '01991a20-7b40-7000-8000-000000000010',
    walletId: '01991a20-7b40-7000-8000-000000000011',
    transactionId: '01991a20-7b40-7000-8000-000000000012',
    entrySequence: 1n,
    direction: 'CREDIT' as const,
    amount: Money.create({ amount: '100.00', currency: 'BRL' }),
    balanceBefore: Money.create({ amount: '0.00', currency: 'BRL' }),
    previousEntryHash: null,
    createdAt: CREATED_AT,
  };
}

describe('WalletLedgerEntry', () => {
  test('creates the first credit from zero with exact arithmetic', async () => {
    const { WalletLedgerEntry } = await loadLedgerEntry();
    const entry = WalletLedgerEntry.create(baseInput());

    expect(entry.entrySequence).toBe(1n);
    expect(entry.direction).toBe('CREDIT');
    expect(entry.balanceBefore.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(entry.previousEntryHash).toBeNull();
    expect(entry.entryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  test('creates a debit using exact subtraction', async () => {
    const { WalletLedgerEntry } = await loadLedgerEntry();
    const entry = WalletLedgerEntry.create({
      ...baseInput(),
      entrySequence: 2n,
      direction: 'DEBIT',
      amount: Money.create({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.create({ amount: '100.00', currency: 'BRL' }),
      previousEntryHash: 'a'.repeat(64),
    });

    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
  });

  test('rejects a first entry whose opening balance is not zero', async () => {
    const { InvalidLedgerEntryError, WalletLedgerEntry } = await loadLedgerEntry();

    expect(() =>
      WalletLedgerEntry.create({
        ...baseInput(),
        balanceBefore: Money.create({ amount: '1.00', currency: 'BRL' }),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects zero movements and cross-currency balances', async () => {
    const { InvalidLedgerEntryError, WalletLedgerEntry } = await loadLedgerEntry();

    expect(() =>
      WalletLedgerEntry.create({
        ...baseInput(),
        amount: Money.create({ amount: '0.00', currency: 'BRL' }),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...baseInput(),
        balanceBefore: Money.create({ amount: '0.00', currency: 'USD' }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test('rejects a debit that would make the balance negative', async () => {
    const { WalletLedgerEntry } = await loadLedgerEntry();

    expect(() =>
      WalletLedgerEntry.create({
        ...baseInput(),
        entrySequence: 2n,
        direction: 'DEBIT',
        amount: Money.create({ amount: '100.01', currency: 'BRL' }),
        balanceBefore: Money.create({ amount: '100.00', currency: 'BRL' }),
        previousEntryHash: 'a'.repeat(64),
      }),
    ).toThrow(InsufficientMoneyError);
  });

  test('rejects rehydrated state with invalid directional arithmetic', async () => {
    const { InvalidLedgerEntryError, WalletLedgerEntry } = await loadLedgerEntry();

    expect(() =>
      WalletLedgerEntry.rehydrate({
        id: '01991a20-7b40-7000-8000-000000000010',
        walletId: '01991a20-7b40-7000-8000-000000000011',
        transactionId: '01991a20-7b40-7000-8000-000000000012',
        entrySequence: 1n,
        direction: 'CREDIT',
        amountMinor: 10_000n,
        currency: 'BRL',
        balanceBeforeMinor: 0n,
        balanceAfterMinor: 9_999n,
        previousEntryHash: null,
        entryHash: 'b'.repeat(64),
        createdAt: CREATED_AT,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});
