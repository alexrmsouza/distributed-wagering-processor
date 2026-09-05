import { DomainError } from '../../shared/domain/domain-error.js';

export class IdempotencyConflictError extends DomainError<'IDEMPOTENCY_CONFLICT'> {
  public constructor() {
    super('IDEMPOTENCY_CONFLICT', 'The idempotency identity belongs to another business payload');
  }
}

export class InvalidWagerRequestError extends DomainError<'INVALID_PAYLOAD'> {
  public constructor(message = 'Wagering request payload is invalid') {
    super('INVALID_PAYLOAD', message);
  }
}

export class WagerTransactionNotFoundError extends DomainError<'WAGER_TRANSACTION_NOT_FOUND'> {
  public constructor() {
    super('WAGER_TRANSACTION_NOT_FOUND', 'Wager transaction was not found');
  }
}
