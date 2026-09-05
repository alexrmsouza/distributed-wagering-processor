import { DomainError } from '../../shared/domain/domain-error.js';

export class InvalidWagerTransactionError extends DomainError<'INVALID_PAYLOAD'> {
  public constructor(message: string) {
    super('INVALID_PAYLOAD', message);
  }
}

export class InvalidWagerTransactionStateError extends DomainError<'INVALID_TRANSACTION_STATE'> {
  public constructor(currentStatus: string, targetStatus: string) {
    super(
      'INVALID_TRANSACTION_STATE',
      `Wager transaction cannot transition from ${currentStatus} to ${targetStatus}`,
    );
  }
}

export class TerminalWagerTransactionError extends DomainError<'TERMINAL_TRANSACTION'> {
  public constructor(status: string) {
    super('TERMINAL_TRANSACTION', `Wager transaction is terminal in status ${status}`);
  }
}
