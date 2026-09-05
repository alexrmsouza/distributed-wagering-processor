import type { TransactionRunner } from '../../shared/application/transaction-runner.js';
import type { Wallet } from '../domain/wallet.js';
import type { WalletTransactionContext } from './ports/wallet-transaction-context.js';
import { WalletNotFoundError } from './wallet-errors.js';

export class GetWalletUseCase {
  public constructor(
    private readonly transactionRunner: TransactionRunner<WalletTransactionContext>,
  ) {}

  public execute(walletId: string): Promise<Wallet> {
    return this.transactionRunner.run(async ({ wallets }) => {
      const wallet = await wallets.findById(walletId);
      if (wallet === null) {
        throw new WalletNotFoundError();
      }
      return wallet;
    });
  }
}
