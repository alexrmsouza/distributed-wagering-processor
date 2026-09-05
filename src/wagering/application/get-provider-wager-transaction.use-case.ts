import type { TransactionRunner } from '../../shared/application/transaction-runner.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { WageringTransactionContext } from './ports/wagering-transaction-context.js';
import { WagerTransactionNotFoundError } from './wagering-errors.js';

export interface ProviderWagerTransactionQuery {
  readonly providerId: string;
  readonly externalTransactionId: string;
}

export class GetProviderWagerTransactionUseCase {
  public constructor(
    private readonly transactionRunner: TransactionRunner<WageringTransactionContext>,
  ) {}

  public execute(query: ProviderWagerTransactionQuery): Promise<WagerTransaction> {
    return this.transactionRunner.run(async ({ wagerTransactions }) => {
      const transaction = await wagerTransactions.findByProviderAndExternalId(
        query.providerId,
        query.externalTransactionId,
      );
      if (transaction === null) {
        throw new WagerTransactionNotFoundError();
      }
      return transaction;
    });
  }
}
