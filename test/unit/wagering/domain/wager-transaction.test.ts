import { describe, expect, test } from 'bun:test';

import { Money } from '../../../../src/shared/domain/money.js';
import {
  FAILURE_CODES,
  InvalidFailureCodeError,
  isFailureCode,
} from '../../../../src/wagering/domain/failure-code.js';
import {
  InvalidWagerTransactionStateError,
  TerminalWagerTransactionError,
} from '../../../../src/wagering/domain/wager-transaction.errors.js';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
  type WagerTransactionState,
} from '../../../../src/wagering/domain/wager-transaction.js';

const CREATED_AT = new Date('2026-09-04T12:00:00.000Z');
const PROCESSED_AT = new Date('2026-09-04T12:01:00.000Z');
const IDENTITY = Object.freeze({
  id: '01991a20-7b40-7000-8000-000000000101',
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  payloadHash: 'a'.repeat(64),
  walletId: '01991a20-7b40-7000-8000-000000000102',
  playerId: '01991a20-7b40-7000-8000-000000000103',
  roundId: 'round-987',
  gameId: 'game-456',
  kind: 'BET' as const,
  amount: Money.create({ amount: '25.00', currency: 'BRL' }),
  referenceExternalTransactionId: null,
  referenceTransactionId: null,
});

function createPending(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({ ...IDENTITY, createdAt: CREATED_AT, ...overrides });
}

function createPendingReversal(): WagerTransaction {
  return createPending({
    kind: 'REFUND',
    referenceExternalTransactionId: 'original-transaction-123',
  });
}

function pendingState(overrides: Partial<WagerTransactionState> = {}): WagerTransactionState {
  const { amount, ...identityState } = IDENTITY;

  return {
    ...identityState,
    amountMinor: amount.amountMinor,
    currency: amount.currency,
    status: 'PENDING',
    failureCode: null,
    observedBalanceMinor: null,
    observedBalanceCurrency: null,
    retryAttempts: 0,
    nextRetryAt: null,
    retryExpiresAt: null,
    processedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

describe('WagerTransaction', () => {
  test('exposes exactly the stable failure-code taxonomy', () => {
    expect(Object.values(FAILURE_CODES)).toEqual([
      'INVALID_PAYLOAD',
      'WALLET_NOT_FOUND',
      'CURRENCY_MISMATCH',
      'INSUFFICIENT_FUNDS',
      'REVERSAL_WOULD_OVERDRAW',
      'REFERENCE_NOT_FOUND',
      'INVALID_REFERENCE',
      'REFERENCE_ALREADY_REVERSED',
      'IDEMPOTENCY_CONFLICT',
    ]);
    expect(Object.values(FAILURE_CODES).every(isFailureCode)).toBe(true);
    expect(isFailureCode('NOT_STABLE')).toBe(false);
  });

  test('creates an immutable pending transaction with exact monetary identity', () => {
    const transaction = createPending();

    expect(transaction.toState()).toEqual(pendingState());
    expect(transaction.amount.amountMinor).toBe(2_500n);
    expect(transaction.amount.currency).toBe('BRL');
    expect(Object.isFrozen(transaction)).toBe(true);
    expect(Object.isFrozen(transaction.toState())).toBe(true);
  });

  test('processes a pending transaction and preserves the original observed balance', () => {
    const pending = createPending();
    const observedBalance = Money.create({ amount: '75.00', currency: 'BRL' });
    const processed = pending.process({ observedBalance, processedAt: PROCESSED_AT });

    expect(pending.status).toBe('PENDING');
    expect(processed.status).toBe('PROCESSED');
    expect(processed.failureCode).toBeNull();
    expect(processed.observedBalance?.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(processed.processedAt).toEqual(PROCESSED_AT);
    expect(processed.toState()).toMatchObject({
      ...pendingState(),
      status: 'PROCESSED',
      observedBalanceMinor: 7_500n,
      observedBalanceCurrency: 'BRL',
      processedAt: PROCESSED_AT,
      updatedAt: PROCESSED_AT,
    });
  });

  test('rejects with only a stable failure code and retains the observed balance', () => {
    const rejected = createPending().reject({
      failureCode: FAILURE_CODES.INSUFFICIENT_FUNDS,
      observedBalance: Money.create({ amount: '10.00', currency: 'BRL' }),
      processedAt: PROCESSED_AT,
    });

    expect(rejected.status).toBe('REJECTED');
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected.observedBalance?.amountMinor).toBe(1_000n);
    expect(isFailureCode(rejected.failureCode)).toBe(true);

    const rejectedWithoutObservableWallet = createPending().reject({
      failureCode: FAILURE_CODES.WALLET_NOT_FOUND,
      observedBalance: null,
      processedAt: PROCESSED_AT,
    });
    expect(rejectedWithoutObservableWallet.observedBalance).toBeNull();

    expect(() =>
      WagerTransaction.rehydrate(
        pendingState({
          status: 'REJECTED',
          failureCode: 'NOT_STABLE' as never,
          observedBalanceMinor: 1_000n,
          observedBalanceCurrency: 'BRL',
          processedAt: PROCESSED_AT,
          updatedAt: PROCESSED_AT,
        }),
      ),
    ).toThrow(InvalidFailureCodeError);
  });

  test('uses FAILED only for a classified permanent infrastructure failure from PENDING', () => {
    const observedBalance = Money.create({ amount: '100.00', currency: 'BRL' });
    const failed = createPending().failForPermanentInfrastructure({
      observedBalance,
      processedAt: PROCESSED_AT,
    });

    expect(failed.status).toBe('FAILED');
    expect(failed.failureCode).toBeNull();
    expect(failed.observedBalance?.equals(observedBalance)).toBe(true);
    expect(failed.processedAt).toEqual(PROCESSED_AT);

    const pendingReference = createPendingReversal().markPendingReference({
      retryAttempts: 1,
      nextRetryAt: new Date('2026-09-04T12:00:30.000Z'),
      retryExpiresAt: new Date('2026-09-05T12:00:00.000Z'),
      updatedAt: new Date('2026-09-04T12:00:01.000Z'),
    });

    expect(() =>
      pendingReference.failForPermanentInfrastructure({
        observedBalance,
        processedAt: PROCESSED_AT,
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test('allows pending-reference transactions to process or reject but never fail', () => {
    const pendingReference = createPendingReversal().markPendingReference({
      retryAttempts: 1,
      nextRetryAt: new Date('2026-09-04T12:00:30.000Z'),
      retryExpiresAt: new Date('2026-09-05T12:00:00.000Z'),
      updatedAt: new Date('2026-09-04T12:00:01.000Z'),
    });
    const observedBalance = Money.create({ amount: '100.00', currency: 'BRL' });

    expect(pendingReference.status).toBe('PENDING_REFERENCE');
    expect(pendingReference.process({ observedBalance, processedAt: PROCESSED_AT }).status).toBe(
      'PROCESSED',
    );
    expect(
      pendingReference.reject({
        failureCode: FAILURE_CODES.REFERENCE_NOT_FOUND,
        observedBalance,
        processedAt: PROCESSED_AT,
      }).status,
    ).toBe('REJECTED');
  });

  test('prevents every transition out of terminal states', () => {
    const observedBalance = Money.create({ amount: '75.00', currency: 'BRL' });
    const terminalTransactions = [
      createPending().process({ observedBalance, processedAt: PROCESSED_AT }),
      createPending().reject({
        failureCode: FAILURE_CODES.INSUFFICIENT_FUNDS,
        observedBalance,
        processedAt: PROCESSED_AT,
      }),
      createPending().failForPermanentInfrastructure({
        observedBalance,
        processedAt: PROCESSED_AT,
      }),
    ];

    for (const transaction of terminalTransactions) {
      expect(() => transaction.process({ observedBalance, processedAt: PROCESSED_AT })).toThrow(
        TerminalWagerTransactionError,
      );
      expect(() =>
        transaction.reject({
          failureCode: FAILURE_CODES.INVALID_PAYLOAD,
          observedBalance,
          processedAt: PROCESSED_AT,
        }),
      ).toThrow(TerminalWagerTransactionError);
      expect(() =>
        transaction.failForPermanentInfrastructure({ observedBalance, processedAt: PROCESSED_AT }),
      ).toThrow(TerminalWagerTransactionError);
    }
  });

  test('rehydrates immutable business identity and returns defensive timestamp copies', () => {
    const state = pendingState({
      status: 'PROCESSED',
      observedBalanceMinor: 7_500n,
      observedBalanceCurrency: 'BRL',
      processedAt: PROCESSED_AT,
      updatedAt: PROCESSED_AT,
    });
    const transaction = WagerTransaction.rehydrate(state);
    const createdAt = transaction.createdAt;
    const processedAt = transaction.processedAt;

    createdAt.setUTCFullYear(2000);
    processedAt?.setUTCFullYear(2000);

    expect(transaction.createdAt).toEqual(CREATED_AT);
    expect(transaction.processedAt).toEqual(PROCESSED_AT);
    expect(transaction.toState()).toMatchObject({
      id: IDENTITY.id,
      providerId: IDENTITY.providerId,
      externalTransactionId: IDENTITY.externalTransactionId,
      idempotencyKey: IDENTITY.idempotencyKey,
      payloadHash: IDENTITY.payloadHash,
      walletId: IDENTITY.walletId,
      playerId: IDENTITY.playerId,
      roundId: IDENTITY.roundId,
      gameId: IDENTITY.gameId,
      kind: IDENTITY.kind,
      amountMinor: 2_500n,
      currency: 'BRL',
    });
  });
});
