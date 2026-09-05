import type { ProcessWagerTransactionResult } from '../application/process-wager-transaction.use-case.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';

export const WagerTransactionPresenter = {
  presentOutcome(result: ProcessWagerTransactionResult) {
    return Object.freeze({
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance.toJSON(),
      idempotentReplay: result.idempotentReplay,
      ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
    });
  },

  presentTransaction(transaction: WagerTransaction) {
    return Object.freeze({
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.amount.toJSON(),
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      observedBalance: transaction.observedBalance?.toJSON() ?? null,
      processedAt: transaction.processedAt?.toISOString() ?? null,
      createdAt: transaction.createdAt.toISOString(),
    });
  },
};
