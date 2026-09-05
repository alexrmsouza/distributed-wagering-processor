import { Histogram, register, type Registry } from 'prom-client';

import type {
  WalletLockMetrics,
  WalletLockOutcome,
} from '../../application/ports/wallet-lock-metrics.js';

export class PrometheusWalletLockMetrics implements WalletLockMetrics {
  readonly #waitDuration: Histogram<'outcome'>;
  readonly #onConflict: () => void;

  public constructor(registry: Registry = register, onConflict: () => void = () => undefined) {
    this.#waitDuration =
      (registry.getSingleMetric('wallet_lock_wait_seconds') as Histogram<'outcome'> | undefined) ??
      new Histogram({
        name: 'wallet_lock_wait_seconds',
        help: 'Time spent waiting to acquire a wallet-scoped PostgreSQL lock',
        labelNames: ['outcome'],
        buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
        registers: [registry],
      });
    this.#onConflict = onConflict;
  }

  public observeWait(durationSeconds: number, outcome: WalletLockOutcome): void {
    this.#waitDuration.observe({ outcome }, durationSeconds);
  }

  public recordConflict(): void {
    this.#onConflict();
  }
}
