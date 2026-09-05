import { describe, expect, test } from 'bun:test';

const FIRST_HASH = 'fccb53a576ffd3ea03ae441ff8c2e7bb09df621d6a8db8846c8015a03080abc6';
const SECOND_HASH = '6798b907595ea716ad9bfcfa6f36cac977f55c0983240f3f49b14e96f48c60c8';

const FIRST_ENTRY = Object.freeze({
  walletId: '01991a20-7b40-7000-8000-000000000011',
  transactionId: '01991a20-7b40-7000-8000-000000000012',
  entrySequence: 1n,
  direction: 'CREDIT' as const,
  amountMinor: 10_000n,
  currency: 'BRL',
  balanceBeforeMinor: 0n,
  balanceAfterMinor: 10_000n,
  previousEntryHash: null,
  createdAt: new Date('2026-09-04T12:00:00.000Z'),
});

const SECOND_ENTRY = Object.freeze({
  walletId: FIRST_ENTRY.walletId,
  transactionId: '01991a20-7b40-7000-8000-000000000013',
  entrySequence: 2n,
  direction: 'DEBIT' as const,
  amountMinor: 2_500n,
  currency: 'BRL',
  balanceBeforeMinor: 10_000n,
  balanceAfterMinor: 7_500n,
  previousEntryHash: FIRST_HASH,
  createdAt: new Date('2026-09-04T12:01:00.000Z'),
});

async function loadHashChain() {
  return import('../../../../src/wallet/domain/ledger-hash-chain.js');
}

describe('LedgerHashChain', () => {
  test('calculates a stable canonical SHA-256 hash for the first entry', async () => {
    const { LedgerHashChain } = await loadHashChain();

    expect(LedgerHashChain.calculate(FIRST_ENTRY)).toBe(FIRST_HASH);
    expect(LedgerHashChain.calculate({ ...FIRST_ENTRY })).toBe(FIRST_HASH);
  });

  test('links each subsequent entry to the prior hash', async () => {
    const { LedgerHashChain } = await loadHashChain();

    expect(LedgerHashChain.calculate(SECOND_ENTRY)).toBe(SECOND_HASH);
    expect(
      LedgerHashChain.verify([
        { ...FIRST_ENTRY, entryHash: FIRST_HASH },
        { ...SECOND_ENTRY, entryHash: SECOND_HASH },
      ]),
    ).toBe(true);
  });

  test('detects tampered financial data without repairing it', async () => {
    const { LedgerHashChain } = await loadHashChain();

    expect(
      LedgerHashChain.verify([
        { ...FIRST_ENTRY, entryHash: FIRST_HASH },
        { ...SECOND_ENTRY, amountMinor: 2_499n, entryHash: SECOND_HASH },
      ]),
    ).toBe(false);
  });

  test('rejects a recomputed hash that preserves invalid financial arithmetic', async () => {
    const { LedgerHashChain } = await loadHashChain();
    const invalidArithmetic = { ...SECOND_ENTRY, balanceAfterMinor: 7_501n };

    expect(
      LedgerHashChain.verify([
        { ...FIRST_ENTRY, entryHash: FIRST_HASH },
        {
          ...invalidArithmetic,
          entryHash: LedgerHashChain.calculate(invalidArithmetic),
        },
      ]),
    ).toBe(false);
  });

  test('rejects a valid chain belonging to a different wallet currency', async () => {
    const { LedgerHashChain } = await loadHashChain();

    expect(LedgerHashChain.verify([{ ...FIRST_ENTRY, entryHash: FIRST_HASH }], 'USD')).toBe(false);
  });

  test('rejects a sequence gap, reordered entries, and an invalid prior link', async () => {
    const { LedgerHashChain } = await loadHashChain();
    const first = { ...FIRST_ENTRY, entryHash: FIRST_HASH };
    const second = { ...SECOND_ENTRY, entryHash: SECOND_HASH };

    expect(LedgerHashChain.verify([second, first])).toBe(false);
    expect(LedgerHashChain.verify([{ ...first, entrySequence: 2n, previousEntryHash: null }])).toBe(
      false,
    );
    expect(LedgerHashChain.verify([{ ...first, previousEntryHash: 'a'.repeat(64) }])).toBe(false);
  });
});
