import type { TransactionBoundRepository } from '../../../shared/application/transaction-runner.js';

export interface WagerTransactionRepository<TTransaction> extends TransactionBoundRepository {
  findById(transactionId: string, lock?: boolean): Promise<TTransaction | null>;
  findByExternalId(externalTransactionId: string): Promise<TTransaction | null>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
    lock?: boolean,
  ): Promise<TTransaction | null>;
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
    lock?: boolean,
  ): Promise<TTransaction | null>;
  findReversalByReference(
    referenceTransactionId: string,
    kind: 'REFUND' | 'ROLLBACK',
    excludingTransactionId: string,
  ): Promise<TTransaction | null>;
  insert(transaction: TTransaction): Promise<boolean>;
  save(transaction: TTransaction): Promise<void>;
}
