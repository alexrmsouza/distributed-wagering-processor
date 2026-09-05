import type { TransactionRunner } from '../../shared/application/transaction-runner.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import type { WalletTransactionContext } from './ports/wallet-transaction-context.js';
import { LedgerCursor } from './ledger-cursor.js';
import { WalletNotFoundError } from './wallet-errors.js';

export interface ListWalletLedgerQuery {
  readonly walletId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WalletLedgerPage {
  readonly items: readonly WalletLedgerEntry[];
  readonly nextCursor: string | null;
}

export class ListWalletLedgerUseCase {
  public constructor(
    private readonly transactionRunner: TransactionRunner<WalletTransactionContext>,
  ) {}

  public execute(query: ListWalletLedgerQuery): Promise<WalletLedgerPage> {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Ledger page limit must be an integer between 1 and 100');
    }
    const after = query.cursor === undefined ? null : LedgerCursor.decode(query.cursor);

    return this.transactionRunner.run(async ({ wallets }) => {
      if ((await wallets.findById(query.walletId)) === null) {
        throw new WalletNotFoundError();
      }

      const rows = await wallets.listLedgerPage({
        walletId: query.walletId,
        after,
        limit: limit + 1,
      });
      const hasNextPage = rows.length > limit;
      const items = Object.freeze(rows.slice(0, limit));
      const boundary = items.at(-1);

      return Object.freeze({
        items,
        nextCursor:
          hasNextPage && boundary !== undefined
            ? LedgerCursor.encode({ createdAt: boundary.createdAt, id: boundary.id })
            : null,
      });
    });
  }
}
