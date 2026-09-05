import { beforeAll, expect, test } from 'bun:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Registry } from 'prom-client';

import { OBSERVABILITY_METRICS } from '../../src/observability/observability.tokens.js';
import { MetricsController } from '../../src/observability/presentation/metrics.controller.js';
import type { WalletLockMetrics } from '../../src/wallet/application/ports/wallet-lock-metrics.js';

const METRICS_MODULE_PATH = '../../src/observability/infrastructure/prometheus-metrics.js';

interface PrometheusMetricsContract {
  readonly walletLockMetrics: WalletLockMetrics;
  recordTransaction(
    status: 'FAILED' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED',
    kind: 'BET' | 'LOSS' | 'REFUND' | 'ROLLBACK' | 'WIN',
    transport: 'http' | 'sqs',
  ): void;
  recordDuplicate(source: 'http' | 'sqs_command'): void;
  recordRetry(component: 'outbox' | 'pending_reference' | 'sqs_command'): void;
  recordDeadLetter(reason: 'malformed_envelope' | 'permanent_transport'): void;
  recordLockConflict(): void;
  observeOutboxLag(durationSeconds: number): void;
  observeProcessingDuration(durationSeconds: number, transport: 'http' | 'sqs'): void;
  recordReconciliationDivergence(): void;
  recordInbox(outcome: 'completed' | 'duplicate' | 'conflict' | 'retryable'): void;
  recordOutboxPublication(outcome: 'published' | 'rescheduled' | 'skipped'): void;
}

type PrometheusMetricsConstructor = new (registry: Registry) => PrometheusMetricsContract;

let prometheusMetricsConstructor: PrometheusMetricsConstructor | undefined;

const FORBIDDEN_LABEL_KEYS = [
  'amount',
  'correlationId',
  'error',
  'eventId',
  'messageId',
  'providerId',
  'transactionId',
  'walletId',
] as const;

function labelKeys(exposition: string): Set<string> {
  const keys = new Set<string>();
  for (const match of exposition.matchAll(/\{([^}]*)\}/g)) {
    const labels = match[1];
    if (labels === undefined || labels.length === 0) {
      continue;
    }
    for (const label of labels.split(',')) {
      const key = label.split('=')[0];
      if (key !== undefined) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a module object');
  }
  return value as Record<string, unknown>;
}

function metricsConstructor(): PrometheusMetricsConstructor {
  if (prometheusMetricsConstructor === undefined) {
    throw new Error('Prometheus metrics implementation is unavailable');
  }
  return prometheusMetricsConstructor;
}

beforeAll(async () => {
  const module: unknown = await import(METRICS_MODULE_PATH);
  const candidate = asRecord(module).PrometheusMetrics;
  if (typeof candidate !== 'function') {
    throw new TypeError('PrometheusMetrics export is unavailable');
  }
  prometheusMetricsConstructor = candidate as PrometheusMetricsConstructor;
});

test('records required operational metrics with bounded labels', async () => {
  const registry = new Registry();
  const Metrics = metricsConstructor();
  const metrics = new Metrics(registry);

  metrics.recordTransaction('PROCESSED', 'BET', 'http');
  metrics.recordTransaction('REJECTED', 'WIN', 'sqs');
  metrics.recordTransaction('FAILED', 'REFUND', 'sqs');
  metrics.recordTransaction('PENDING_REFERENCE', 'ROLLBACK', 'http');
  metrics.recordDuplicate('http');
  metrics.recordDuplicate('sqs_command');
  metrics.recordRetry('pending_reference');
  metrics.recordRetry('outbox');
  metrics.recordRetry('sqs_command');
  metrics.recordDeadLetter('malformed_envelope');
  metrics.recordDeadLetter('permanent_transport');
  metrics.recordLockConflict();
  metrics.walletLockMetrics.observeWait(0.125, 'acquired');
  metrics.walletLockMetrics.observeWait(0.25, 'not_found');
  metrics.walletLockMetrics.observeWait(0.5, 'failed');
  metrics.observeOutboxLag(2.5);
  metrics.observeProcessingDuration(0.075, 'http');
  metrics.observeProcessingDuration(0.125, 'sqs');
  metrics.recordReconciliationDivergence();
  metrics.recordInbox('completed');
  metrics.recordInbox('duplicate');
  metrics.recordInbox('conflict');
  metrics.recordInbox('retryable');
  metrics.recordOutboxPublication('published');
  metrics.recordOutboxPublication('rescheduled');
  metrics.recordOutboxPublication('skipped');

  const exposition = await registry.metrics();
  expect(exposition).toContain(
    'wager_transactions_total{status="PROCESSED",kind="BET",transport="http"} 1',
  );
  expect(exposition).toContain(
    'wager_transactions_total{status="REJECTED",kind="WIN",transport="sqs"} 1',
  );
  expect(exposition).toContain('wager_duplicates_total{source="http"} 1');
  expect(exposition).toContain('wager_retries_total{component="outbox"} 1');
  expect(exposition).toContain('wager_dlq_messages_total{reason="malformed_envelope"} 1');
  expect(exposition).toContain('wallet_lock_conflicts_total 1');
  expect(exposition).toContain('wallet_lock_wait_seconds_count{outcome="acquired"} 1');
  expect(exposition).toContain('outbox_lag_seconds_count 1');
  expect(exposition).toContain('wager_processing_duration_seconds_count{transport="http"} 1');
  expect(exposition).toContain('wallet_reconciliation_divergences_total 1');
  expect(exposition).toContain('inbox_processing_total{outcome="completed"} 1');
  expect(exposition).toContain('outbox_publications_total{outcome="published"} 1');

  const observedLabelKeys = labelKeys(exposition);
  expect(observedLabelKeys).toEqual(
    new Set(['component', 'kind', 'le', 'outcome', 'reason', 'source', 'status', 'transport']),
  );
  for (const forbiddenLabel of FORBIDDEN_LABEL_KEYS) {
    expect(observedLabelKeys).not.toContain(forbiddenLabel);
  }
  expect(exposition).not.toContain('25.00');
  expect(exposition).not.toContain('provider-secret');
  expect(exposition).not.toContain('wallet-identifier');
  expect(exposition).not.toContain('password=secret');
  expect(exposition).not.toContain('duplicate key value violates unique constraint');
});

test('reuses collectors when the same registry is initialized repeatedly', async () => {
  const registry = new Registry();
  const Metrics = metricsConstructor();
  const first = new Metrics(registry);
  const second = new Metrics(registry);

  first.recordTransaction('PROCESSED', 'BET', 'http');
  second.recordTransaction('PROCESSED', 'BET', 'http');
  first.walletLockMetrics.observeWait(0.01, 'acquired');
  second.walletLockMetrics.observeWait(0.02, 'acquired');

  const exposition = await registry.metrics();
  expect(exposition).toContain(
    'wager_transactions_total{status="PROCESSED",kind="BET",transport="http"} 2',
  );
  expect(exposition).toContain('wallet_lock_wait_seconds_count{outcome="acquired"} 2');
  expect(registry.getSingleMetric('wager_transactions_total')).toBeDefined();
  expect(registry.getSingleMetric('wallet_lock_wait_seconds')).toBeDefined();
});

test('rejects arbitrary runtime label values before recording them', () => {
  const Metrics = metricsConstructor();
  const metrics = new Metrics(new Registry());

  expect(() => {
    metrics.recordTransaction('wallet-identifier' as never, 'BET', 'http');
  }).toThrow();
  expect(() => {
    metrics.recordTransaction('PROCESSED', 'provider-secret' as never, 'http');
  }).toThrow();
  expect(() => {
    metrics.recordDuplicate('provider-secret' as never);
  }).toThrow();
  expect(() => {
    metrics.recordRetry('password=secret' as never);
  }).toThrow();
  expect(() => {
    metrics.recordDeadLetter('duplicate key value violates unique constraint' as never);
  }).toThrow();
  expect(() => {
    metrics.observeProcessingDuration(0.1, 'message-identifier' as never);
  }).toThrow();
});

test('exposes the shared registry through the public Prometheus endpoint', async () => {
  const registry = new Registry();
  const Metrics = metricsConstructor();
  const metrics = new Metrics(registry);
  metrics.recordTransaction('PROCESSED', 'BET', 'http');

  @Module({
    controllers: [MetricsController],
    providers: [{ provide: OBSERVABILITY_METRICS, useValue: metrics }],
  })
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest uses this class as a module metadata root.
  class MetricsTestModule {}

  const application = await NestFactory.create(MetricsTestModule, { logger: false });
  await application.listen(0, '127.0.0.1');
  try {
    const response = await fetch(`${await application.getUrl()}/metrics`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toContain(
      'wager_transactions_total{status="PROCESSED",kind="BET",transport="http"} 1',
    );
  } finally {
    await application.close();
  }
});
