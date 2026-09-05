import type { Money } from '../../shared/domain/money.js';
import { FAILURE_CODES } from './failure-code.js';
import type { WagerTransaction, WagerTransactionKind } from './wager-transaction.js';

export type ReversalDirection = 'DEBIT' | 'CREDIT';
type ReversalFailureCode =
  typeof FAILURE_CODES.INVALID_REFERENCE | typeof FAILURE_CODES.REFERENCE_ALREADY_REVERSED;

export interface ReversalValidationInput {
  readonly transaction: WagerTransaction;
  readonly reference: WagerTransaction;
  readonly duplicateExists: boolean;
}

export type ReversalValidationResult =
  | Readonly<{
      valid: true;
      direction: ReversalDirection;
      amount: Money;
      referenceTransactionId: string;
    }>
  | Readonly<{
      valid: false;
      failureCode: ReversalFailureCode;
    }>;

const INVALID_REFERENCE = Object.freeze({
  valid: false,
  failureCode: FAILURE_CODES.INVALID_REFERENCE,
} as const);

const REFERENCE_ALREADY_REVERSED = Object.freeze({
  valid: false,
  failureCode: FAILURE_CODES.REFERENCE_ALREADY_REVERSED,
} as const);

export function validateReversal(input: ReversalValidationInput): ReversalValidationResult {
  const { transaction, reference } = input;
  const direction = resolveDirection(transaction.kind, reference.kind);

  if (direction === null || !hasCompatibleReference(transaction, reference)) {
    return INVALID_REFERENCE;
  }

  if (input.duplicateExists) {
    return REFERENCE_ALREADY_REVERSED;
  }

  return Object.freeze({
    valid: true,
    direction,
    amount: transaction.amount,
    referenceTransactionId: reference.id,
  });
}

function resolveDirection(
  reversalKind: WagerTransactionKind,
  referenceKind: WagerTransactionKind,
): ReversalDirection | null {
  if (reversalKind === 'REFUND') {
    return referenceKind === 'BET' ? 'CREDIT' : null;
  }

  if (reversalKind !== 'ROLLBACK') {
    return null;
  }

  if (referenceKind === 'BET') {
    return 'CREDIT';
  }

  return referenceKind === 'WIN' || referenceKind === 'REFUND' ? 'DEBIT' : null;
}

function hasCompatibleReference(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): boolean {
  if (
    (transaction.status !== 'PENDING' && transaction.status !== 'PENDING_REFERENCE') ||
    reference.status !== 'PROCESSED' ||
    transaction.id === reference.id ||
    transaction.externalTransactionId === reference.externalTransactionId ||
    transaction.referenceExternalTransactionId !== reference.externalTransactionId ||
    (transaction.referenceTransactionId !== null &&
      transaction.referenceTransactionId !== reference.id)
  ) {
    return false;
  }

  return (
    transaction.providerId === reference.providerId &&
    transaction.walletId === reference.walletId &&
    transaction.playerId === reference.playerId &&
    transaction.roundId === reference.roundId &&
    transaction.gameId === reference.gameId &&
    transaction.amount.equals(reference.amount)
  );
}
