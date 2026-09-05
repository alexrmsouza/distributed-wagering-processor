import type { TransactionBoundRepository } from '../../../shared/application/transaction-runner.js';

export interface OpeningTransactionState {
  readonly id: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly observedBalanceMinor: bigint;
  readonly occurredAt: Date;
}

export interface OpeningTransactionRepository extends TransactionBoundRepository {
  insertOpening(state: OpeningTransactionState): Promise<void>;
}
