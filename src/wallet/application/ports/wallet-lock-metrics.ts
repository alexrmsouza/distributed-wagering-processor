export type WalletLockOutcome = 'acquired' | 'not_found' | 'failed';

export interface WalletLockMetrics {
  observeWait(durationSeconds: number, outcome: WalletLockOutcome): void;
  recordConflict?(): void;
}

export const NOOP_WALLET_LOCK_METRICS: WalletLockMetrics = Object.freeze({
  observeWait: () => undefined,
});
