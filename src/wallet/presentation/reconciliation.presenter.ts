import type { PublicMoney } from '../../shared/domain/money.js';
import type { WalletReconciliationResult } from '../application/reconcile-wallet.use-case.js';

function presentSignedMoney(amountMinor: bigint, currency: string): PublicMoney {
  const sign = amountMinor < 0n ? '-' : '';
  const absolute = amountMinor < 0n ? -amountMinor : amountMinor;
  const integral = absolute / 100n;
  const fractional = (absolute % 100n).toString().padStart(2, '0');

  return Object.freeze({
    amount: `${sign}${integral.toString()}.${fractional}`,
    currency,
  });
}

export const ReconciliationPresenter = {
  present(result: WalletReconciliationResult) {
    return Object.freeze({
      walletId: result.walletId,
      storedBalance: presentSignedMoney(result.storedBalanceMinor, result.currency),
      calculatedBalance: presentSignedMoney(result.calculatedBalanceMinor, result.currency),
      accountingBalance: presentSignedMoney(result.accountingBalanceMinor, result.currency),
      difference: presentSignedMoney(result.differenceMinor, result.currency),
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
      accountingBalanced: result.accountingBalanced,
      auditChainValid: result.auditChainValid,
    });
  },
};
