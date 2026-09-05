import { describe, expect, test } from 'bun:test';

import { Money } from '../../../../src/shared/domain/money.js';
import {
  validateReversal,
  type ReversalValidationResult,
} from '../../../../src/wagering/domain/reversal-rules.js';
import {
  WagerTransaction,
  type WagerTransactionKind,
} from '../../../../src/wagering/domain/wager-transaction.js';

const CREATED_AT = new Date('2026-09-04T12:00:00.000Z');
const PROCESSED_AT = new Date('2026-09-04T12:01:00.000Z');
let sequence = 0;

interface TransactionOverrides {
  readonly id?: string;
  readonly providerId?: string;
  readonly externalTransactionId?: string;
  readonly walletId?: string;
  readonly playerId?: string;
  readonly roundId?: string;
  readonly gameId?: string;
  readonly amount?: Money;
  readonly referenceExternalTransactionId?: string | null;
  readonly referenceTransactionId?: string | null;
}

function nextId(): string {
  sequence += 1;
  return `01991a20-7b40-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

function createTransaction(
  kind: WagerTransactionKind,
  overrides: TransactionOverrides = {},
): WagerTransaction {
  const externalTransactionId =
    overrides.externalTransactionId ?? `transaction-${(sequence + 1).toString()}`;
  const isReversal = kind === 'REFUND' || kind === 'ROLLBACK';

  return WagerTransaction.create({
    id: overrides.id ?? nextId(),
    providerId: overrides.providerId ?? 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}:${sequence.toString()}`,
    payloadHash: sequence.toString(16).padStart(64, '0'),
    walletId: overrides.walletId ?? '01991a20-7b40-7000-8000-000000000101',
    playerId: overrides.playerId ?? '01991a20-7b40-7000-8000-000000000102',
    roundId: overrides.roundId ?? 'round-987',
    gameId: overrides.gameId ?? 'fortune-chimp',
    kind,
    amount: overrides.amount ?? Money.create({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId:
      overrides.referenceExternalTransactionId ?? (isReversal ? 'source-transaction' : null),
    referenceTransactionId: overrides.referenceTransactionId ?? null,
    createdAt: CREATED_AT,
  });
}

function processedReference(
  kind: WagerTransactionKind,
  overrides: TransactionOverrides = {},
): WagerTransaction {
  return createTransaction(kind, overrides).process({
    observedBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
    processedAt: PROCESSED_AT,
  });
}

function reversalFor(
  kind: 'REFUND' | 'ROLLBACK',
  reference: WagerTransaction,
  overrides: TransactionOverrides = {},
): WagerTransaction {
  return createTransaction(kind, {
    providerId: reference.providerId,
    walletId: reference.walletId,
    playerId: reference.playerId,
    roundId: reference.roundId,
    gameId: reference.gameId,
    amount: reference.amount,
    referenceExternalTransactionId: reference.externalTransactionId,
    ...overrides,
  });
}

function expectAllowed(
  result: ReversalValidationResult,
  direction: 'DEBIT' | 'CREDIT',
  reference: WagerTransaction,
): void {
  expect(result).toEqual({
    valid: true,
    direction,
    amount: reference.amount,
    referenceTransactionId: reference.id,
  });
}

describe('validateReversal', () => {
  test('allows REFUND only for a processed BET and credits the exact amount', () => {
    const reference = processedReference('BET', { externalTransactionId: 'bet-1' });
    const transaction = reversalFor('REFUND', reference);

    expectAllowed(
      validateReversal({ transaction, reference, duplicateExists: false }),
      'CREDIT',
      reference,
    );
  });

  test.each([
    ['BET', 'CREDIT'],
    ['WIN', 'DEBIT'],
    ['REFUND', 'DEBIT'],
  ] as const)('allows ROLLBACK to invert a processed %s with a %s', (kind, direction) => {
    const reference = processedReference(kind, {
      externalTransactionId: `source-${kind.toLowerCase()}`,
    });
    const transaction = reversalFor('ROLLBACK', reference);

    expectAllowed(
      validateReversal({ transaction, reference, duplicateExists: false }),
      direction,
      reference,
    );
  });

  test.each(['WIN', 'LOSS', 'REFUND', 'ROLLBACK', 'OPENING'] as const)(
    'rejects REFUND referencing %s',
    (kind) => {
      const reference = processedReference(kind, { externalTransactionId: `source-${kind}` });
      const transaction = reversalFor('REFUND', reference);

      expect(validateReversal({ transaction, reference, duplicateExists: false })).toEqual({
        valid: false,
        failureCode: 'INVALID_REFERENCE',
      });
    },
  );

  test.each(['LOSS', 'ROLLBACK', 'OPENING'] as const)('rejects ROLLBACK referencing %s', (kind) => {
    const reference = processedReference(kind, { externalTransactionId: `source-${kind}` });
    const transaction = reversalFor('ROLLBACK', reference);

    expect(validateReversal({ transaction, reference, duplicateExists: false })).toEqual({
      valid: false,
      failureCode: 'INVALID_REFERENCE',
    });
  });

  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['wallet', { walletId: '01991a20-7b40-7000-8000-000000000999' }],
    ['player', { playerId: '01991a20-7b40-7000-8000-000000000999' }],
    ['currency', { amount: Money.create({ amount: '25.00', currency: 'USD' }) }],
    ['amount', { amount: Money.create({ amount: '24.99', currency: 'BRL' }) }],
    ['round', { roundId: 'round-other' }],
    ['game', { gameId: 'game-other' }],
    ['external reference', { referenceExternalTransactionId: 'transaction-other' }],
    ['resolved internal reference', { referenceTransactionId: 'transaction-other' }],
  ] satisfies readonly (readonly [string, TransactionOverrides])[])(
    'rejects a reversal with mismatched %s context',
    (_name, overrides) => {
      const reference = processedReference('BET', { externalTransactionId: 'bet-context' });
      const transaction = reversalFor('REFUND', reference, overrides);

      expect(validateReversal({ transaction, reference, duplicateExists: false })).toEqual({
        valid: false,
        failureCode: 'INVALID_REFERENCE',
      });
    },
  );

  test.each(['PENDING', 'REJECTED', 'FAILED'] as const)(
    'rejects a reference in %s status',
    (status) => {
      const pending = createTransaction('BET', { externalTransactionId: `bet-${status}` });
      const reference =
        status === 'PENDING'
          ? pending
          : status === 'REJECTED'
            ? pending.reject({
                failureCode: 'INVALID_REFERENCE',
                observedBalance: null,
                processedAt: PROCESSED_AT,
              })
            : pending.failForPermanentInfrastructure({
                observedBalance: null,
                processedAt: PROCESSED_AT,
              });
      const transaction = reversalFor('REFUND', reference);

      expect(validateReversal({ transaction, reference, duplicateExists: false })).toEqual({
        valid: false,
        failureCode: 'INVALID_REFERENCE',
      });
    },
  );

  test('allows a compatible pending-reference reversal to resume', () => {
    const reference = processedReference('BET', { externalTransactionId: 'bet-late' });
    const transaction = reversalFor('REFUND', reference).markPendingReference({
      retryAttempts: 1,
      nextRetryAt: new Date('2026-09-04T12:02:00.000Z'),
      retryExpiresAt: new Date('2026-09-05T12:00:00.000Z'),
      updatedAt: new Date('2026-09-04T12:01:30.000Z'),
    });

    expectAllowed(
      validateReversal({ transaction, reference, duplicateExists: false }),
      'CREDIT',
      reference,
    );
  });

  test('rejects a reversal candidate that is already terminal', () => {
    const reference = processedReference('BET', { externalTransactionId: 'bet-terminal' });
    const transaction = reversalFor('REFUND', reference).process({
      observedBalance: Money.create({ amount: '125.00', currency: 'BRL' }),
      processedAt: PROCESSED_AT,
    });

    expect(validateReversal({ transaction, reference, duplicateExists: false })).toEqual({
      valid: false,
      failureCode: 'INVALID_REFERENCE',
    });
  });

  test('rejects a non-reversal candidate and self-reference', () => {
    const reference = processedReference('BET', { externalTransactionId: 'bet-self' });
    const nonReversal = createTransaction('BET');
    const selfReference = reversalFor('REFUND', reference, {
      id: reference.id,
      externalTransactionId: reference.externalTransactionId,
    });

    expect(
      validateReversal({ transaction: nonReversal, reference, duplicateExists: false }),
    ).toEqual({
      valid: false,
      failureCode: 'INVALID_REFERENCE',
    });
    expect(
      validateReversal({ transaction: selfReference, reference, duplicateExists: false }),
    ).toEqual({
      valid: false,
      failureCode: 'INVALID_REFERENCE',
    });
  });

  test('classifies an otherwise valid duplicate with REFERENCE_ALREADY_REVERSED', () => {
    const reference = processedReference('BET', { externalTransactionId: 'bet-duplicate' });
    const transaction = reversalFor('REFUND', reference);

    expect(validateReversal({ transaction, reference, duplicateExists: true })).toEqual({
      valid: false,
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
  });

  test('checks reference compatibility before duplicate classification', () => {
    const reference = processedReference('BET', { externalTransactionId: 'bet-invalid-duplicate' });
    const transaction = reversalFor('REFUND', reference, { providerId: 'provider-b' });

    expect(validateReversal({ transaction, reference, duplicateExists: true })).toEqual({
      valid: false,
      failureCode: 'INVALID_REFERENCE',
    });
  });
});
