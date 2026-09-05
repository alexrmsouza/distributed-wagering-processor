import type { WalletLedgerPage } from '../application/list-wallet-ledger.use-case.js';
import { WalletPresenter } from './wallet.presenter.js';

export const LedgerPresenter = {
  present(page: WalletLedgerPage) {
    return Object.freeze({
      items: Object.freeze(
        page.items.map((entry) =>
          Object.freeze({
            id: entry.id,
            walletId: entry.walletId,
            transactionId: entry.transactionId,
            entrySequence: WalletPresenter.toSafeNumber(entry.entrySequence, 'Ledger sequence'),
            direction: entry.direction,
            amount: entry.amount.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            previousEntryHash: entry.previousEntryHash,
            entryHash: entry.entryHash,
            createdAt: entry.createdAt.toISOString(),
          }),
        ),
      ),
      nextCursor: page.nextCursor,
    });
  },
};
