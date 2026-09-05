import type { TransactionRunner } from '../../shared/application/transaction-runner.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { WageringTransactionContext } from './ports/wagering-transaction-context.js';
import { WagerTransactionNotFoundError } from './wagering-errors.js';

export class GetWagerTransactionUseCase {
  public constructor(
    private readonly transactionRunner: TransactionRunner<WageringTransactionContext>,
  ) {}

  public execute(transactionId: string): Promise<WagerTransaction> {
    return this.transactionRunner.run(async ({ wagerTransactions }) => {
      const transaction = await wagerTransactions.findById(transactionId);
      if (transaction === null) {
        throw new WagerTransactionNotFoundError();
      }
      return transaction;
    });
  }
}
