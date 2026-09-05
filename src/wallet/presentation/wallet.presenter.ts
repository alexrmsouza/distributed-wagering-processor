import type { PublicMoney } from '../../shared/domain/money.js';
import type { Wallet } from '../domain/wallet.js';

export interface WalletResponse {
  readonly id: string;
  readonly playerId: string;
  readonly balance: PublicMoney;
  readonly version: number;
}

function toSafeNumber(value: bigint, fieldName: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new RangeError(`${fieldName} exceeds the public safe integer range`);
  }
  return numeric;
}

export const WalletPresenter = {
  present(wallet: Wallet): WalletResponse {
    return Object.freeze({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: toSafeNumber(wallet.version, 'Wallet version'),
    });
  },

  toSafeNumber,
};
