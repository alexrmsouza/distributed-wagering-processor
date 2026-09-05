import { DomainError } from '../../shared/domain/domain-error.js';

export const FAILURE_CODES = Object.freeze({
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  REVERSAL_WOULD_OVERDRAW: 'REVERSAL_WOULD_OVERDRAW',
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  INVALID_REFERENCE: 'INVALID_REFERENCE',
  REFERENCE_ALREADY_REVERSED: 'REFERENCE_ALREADY_REVERSED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const);

export type FailureCode = (typeof FAILURE_CODES)[keyof typeof FAILURE_CODES];

const FAILURE_CODE_VALUES = new Set<string>(Object.values(FAILURE_CODES));

export class InvalidFailureCodeError extends DomainError<'INVALID_PAYLOAD'> {
  public constructor() {
    super('INVALID_PAYLOAD', 'Wager transaction failure code is not supported');
  }
}

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && FAILURE_CODE_VALUES.has(value);
}

export function assertFailureCode(value: unknown): asserts value is FailureCode {
  if (!isFailureCode(value)) {
    throw new InvalidFailureCodeError();
  }
}
