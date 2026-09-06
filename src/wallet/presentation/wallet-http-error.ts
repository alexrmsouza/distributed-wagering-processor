import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';

import { DomainError } from '../../shared/domain/domain-error.js';
import {
  InvalidLedgerCursorError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../application/wallet-errors.js';

export function toWalletHttpException(error: unknown): HttpException {
  if (error instanceof HttpException) {
    return error;
  }
  if (error instanceof WalletAlreadyExistsError) {
    return new HttpException({ failureCode: error.code, message: error.message }, 409);
  }
  if (error instanceof WalletNotFoundError) {
    return new HttpException({ failureCode: error.code, message: error.message }, 404);
  }
  if (
    error instanceof InvalidLedgerCursorError ||
    (error instanceof DomainError && error.code === 'INVALID_PAYLOAD') ||
    error instanceof TypeError ||
    error instanceof ZodError
  ) {
    const message = error instanceof Error ? error.message : 'Request payload is invalid';
    return new HttpException({ failureCode: 'INVALID_PAYLOAD', message }, 400);
  }

  return new HttpException(
    { failureCode: 'TRANSIENT_INFRASTRUCTURE', message: 'A dependency is temporarily unavailable' },
    503,
  );
}
