import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';

import { DomainError } from '../domain/domain-error.js';

const BUSINESS_FAILURE_CODES = new Set([
  'WALLET_NOT_FOUND',
  'CURRENCY_MISMATCH',
  'INSUFFICIENT_FUNDS',
  'REVERSAL_WOULD_OVERDRAW',
  'REFERENCE_NOT_FOUND',
  'INVALID_REFERENCE',
  'REFERENCE_ALREADY_REVERSED',
]);

export function toHttpException(error: unknown): HttpException {
  if (error instanceof HttpException) {
    return error;
  }

  if (error instanceof DomainError) {
    const domainError = error as DomainError;
    if (domainError.code === 'INVALID_PAYLOAD') {
      return new HttpException(
        { failureCode: domainError.code, message: domainError.message },
        400,
      );
    }
    if (domainError.code === 'IDEMPOTENCY_CONFLICT') {
      return new HttpException(
        { failureCode: domainError.code, message: domainError.message },
        409,
      );
    }
    if (domainError.code === 'WAGER_TRANSACTION_NOT_FOUND') {
      return new HttpException(
        { failureCode: domainError.code, message: domainError.message },
        404,
      );
    }
    if (BUSINESS_FAILURE_CODES.has(domainError.code)) {
      return new HttpException(
        { failureCode: domainError.code, message: domainError.message },
        422,
      );
    }
  }

  if (error instanceof TypeError || error instanceof ZodError) {
    return new HttpException({ failureCode: 'INVALID_PAYLOAD', message: error.message }, 400);
  }

  return new HttpException(
    { failureCode: 'TRANSIENT_INFRASTRUCTURE', message: 'A dependency is temporarily unavailable' },
    503,
  );
}
