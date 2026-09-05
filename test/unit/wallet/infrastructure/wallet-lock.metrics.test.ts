import { expect, test } from 'bun:test';
import { Registry } from 'prom-client';

import { PrometheusWalletLockMetrics } from '../../../../src/wallet/infrastructure/persistence/wallet-lock.metrics.js';

test('records wallet lock wait time with low-cardinality outcome labels only', async () => {
  const registry = new Registry();
  const metrics = new PrometheusWalletLockMetrics(registry);

  metrics.observeWait(0.125, 'acquired');
  metrics.observeWait(0.25, 'not_found');
  metrics.observeWait(0.5, 'failed');

  const exposition = await registry.metrics();
  expect(exposition).toContain('wallet_lock_wait_seconds_count{outcome="acquired"} 1');
  expect(exposition).toContain('wallet_lock_wait_seconds_count{outcome="not_found"} 1');
  expect(exposition).toContain('wallet_lock_wait_seconds_count{outcome="failed"} 1');
  expect(exposition).not.toContain('walletId');
  expect(exposition).not.toContain('providerId');
});
