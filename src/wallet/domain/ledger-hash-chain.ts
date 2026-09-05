import { hashPayload } from '../../shared/domain/payload-hash.js';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface LedgerHashInput {
  readonly walletId: string;
  readonly transactionId: string;
  readonly entrySequence: bigint;
  readonly direction: LedgerDirection;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly balanceBeforeMinor: bigint;
  readonly balanceAfterMinor: bigint;
  readonly previousEntryHash: string | null;
  readonly createdAt: Date;
}

export interface VerifiableLedgerEntry extends LedgerHashInput {
  readonly entryHash: string;
}

function calculate(input: LedgerHashInput): string {
  return hashPayload({
    schemaVersion: 1,
    walletId: input.walletId,
    transactionId: input.transactionId,
    entrySequence: input.entrySequence.toString(),
    direction: input.direction,
    amountMinor: input.amountMinor.toString(),
    currency: input.currency,
    balanceBeforeMinor: input.balanceBeforeMinor.toString(),
    balanceAfterMinor: input.balanceAfterMinor.toString(),
    previousEntryHash: input.previousEntryHash,
    createdAt: input.createdAt.toISOString(),
  });
}

function verify(entries: readonly VerifiableLedgerEntry[], expectedCurrency?: string): boolean {
  let previous: VerifiableLedgerEntry | undefined;

  for (const entry of entries) {
    const expectedSequence = previous === undefined ? 1n : previous.entrySequence + 1n;
    const expectedPreviousHash = previous?.entryHash ?? null;
    const expectedBalanceBefore = previous?.balanceAfterMinor ?? 0n;
    const expectedBalanceAfter =
      entry.direction === 'CREDIT'
        ? entry.balanceBeforeMinor + entry.amountMinor
        : entry.balanceBeforeMinor - entry.amountMinor;

    if (
      !['DEBIT', 'CREDIT'].includes(entry.direction) ||
      entry.amountMinor <= 0n ||
      entry.balanceBeforeMinor < 0n ||
      entry.balanceAfterMinor < 0n ||
      entry.balanceAfterMinor !== expectedBalanceAfter ||
      entry.entrySequence !== expectedSequence ||
      entry.previousEntryHash !== expectedPreviousHash ||
      entry.balanceBeforeMinor !== expectedBalanceBefore ||
      (expectedCurrency !== undefined && entry.currency !== expectedCurrency) ||
      (previous !== undefined &&
        (entry.walletId !== previous.walletId || entry.currency !== previous.currency)) ||
      calculate(entry) !== entry.entryHash
    ) {
      return false;
    }

    previous = entry;
  }

  return true;
}

export const LedgerHashChain = Object.freeze({ calculate, verify });
