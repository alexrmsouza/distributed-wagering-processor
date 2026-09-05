import { DomainError } from '../../shared/domain/domain-error.js';

export class WalletAlreadyExistsError extends DomainError<'WALLET_ALREADY_EXISTS'> {
  public constructor() {
    super('WALLET_ALREADY_EXISTS', 'A wallet already exists for this player and currency');
  }
}

export class WalletNotFoundError extends DomainError<'WALLET_NOT_FOUND'> {
  public constructor() {
    super('WALLET_NOT_FOUND', 'Wallet was not found');
  }
}

export class InvalidLedgerCursorError extends DomainError<'INVALID_PAYLOAD'> {
  public constructor() {
    super('INVALID_PAYLOAD', 'Ledger cursor is invalid');
  }
}
