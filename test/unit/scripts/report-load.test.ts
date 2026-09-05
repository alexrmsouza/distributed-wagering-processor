import { describe, expect, test } from 'bun:test';

import { formatLoadReport, type LoadReportInput } from '../../../scripts/report-load.js';

const VALID_INPUT: LoadReportInput = {
  schemaVersion: 1,
  metadata: {
    name: 'distributed-wagering-baseline',
    seed: 'distributed-load-seed-001',
    generatedAt: '2026-09-04T12:00:00.000Z',
    measurementDurationMs: 10_000,
    warmupDurationMs: 1_000,
    concurrency: 12,
    processCount: 3,
  },
  environment: {
    platform: 'win32',
    architecture: 'x64',
    bunVersion: '1.4.0',
    dockerMode: 'WSL2',
  },
  traffic: {
    attempted: 10,
    completed: 9,
    http: 6,
    sqs: 4,
    terminalLatencyMs: [40, 10, 90, 30, 70, 20, 80, 50, 60],
  },
  outcomes: {
    processed: 4,
    rejected: 1,
    pendingReference: 1,
    idempotentReplay: 2,
    conflict: 1,
    failed: 0,
    sqsAccepted: 0,
    transientError: 1,
  },
  duplicates: {
    deliveries: 2,
    suppressed: 2,
    logicalEffects: 1,
  },
  locks: {
    conflicts: 1,
    waits: 3,
    waitDurationMs: [5, 15, 10],
  },
  outbox: {
    published: 8,
    pending: 1,
    lagMs: [12, 2, 10, 8, 4, 6, 14, 16],
  },
  reconciliation: {
    walletsChecked: 3,
    consistentWallets: 3,
    divergentWallets: 0,
  },
  correctness: {
    checks: [
      { name: 'EVENTUAL_OUTBOX_PUBLICATION', passed: true },
      { name: 'DUPLICATE_SUPPRESSION', passed: true },
      { name: 'FINANCIAL_INVARIANTS', passed: true },
      { name: 'HOT_WALLET_SERIALIZATION', passed: true },
      { name: 'INDEPENDENT_WALLET_PROGRESS', passed: true },
      { name: 'HTTP_SQS_CONVERGENCE', passed: true },
      { name: 'PENDING_REFERENCE_RESOLUTION', passed: true },
    ],
  },
};

describe('formatLoadReport', () => {
  test('produces stable JSON and Markdown with deterministic metrics', () => {
    const first = formatLoadReport(VALID_INPUT);
    const second = formatLoadReport(VALID_INPUT);

    expect(first).toEqual(second);
    expect(first.report.summary).toEqual({
      correctness: 'PASSED',
      throughputPerSecond: 0.9,
      errorRatePercent: 10,
    });
    expect(first.report.latencyMs).toEqual({
      samples: 9,
      p50: 50,
      p95: 90,
      p99: 90,
    });
    expect(first.report.locks.waitDurationMs).toEqual({
      samples: 3,
      p50: 10,
      p95: 15,
      p99: 15,
    });
    expect(first.report.outbox.lagMs).toEqual({
      samples: 8,
      p50: 8,
      p95: 16,
      p99: 16,
    });
    expect(first.markdown).toContain('| Throughput | 0.90 ops/s |');
    expect(first.markdown).toContain('| Error rate | 10.00% |');
    expect(first.markdown).toContain('| p95 | 90.00 ms |');
    expect(first.markdown).toContain('Runtime timestamp (input metadata)');
    expect(first.json).toBe(`${JSON.stringify(first.report, null, 2)}\n`);
  });

  test('sorts correctness checks in a stable canonical order', () => {
    const result = formatLoadReport(VALID_INPUT);

    expect(result.report.correctness.checks.map(({ name }) => name)).toEqual([
      'HOT_WALLET_SERIALIZATION',
      'INDEPENDENT_WALLET_PROGRESS',
      'HTTP_SQS_CONVERGENCE',
      'DUPLICATE_SUPPRESSION',
      'PENDING_REFERENCE_RESOLUTION',
      'FINANCIAL_INVARIANTS',
      'EVENTUAL_OUTBOX_PUBLICATION',
    ]);
  });

  test('keeps terminal business outcomes separate from transient errors', () => {
    const result = formatLoadReport(VALID_INPUT);

    expect(result.report.outcomes).toEqual(VALID_INPUT.outcomes);
    expect(result.markdown).toContain('| Rejected | 1 |');
    expect(result.markdown).toContain('| Transient error | 1 |');
  });

  test('reports failed scenario-level correctness without mutating input', () => {
    const input = structuredClone(VALID_INPUT);
    const [firstCheck, ...remainingChecks] = input.correctness.checks;
    if (firstCheck === undefined) {
      throw new Error('Expected at least one correctness check');
    }
    input.correctness.checks = [{ ...firstCheck, passed: false }, ...remainingChecks];
    const snapshot = structuredClone(input);

    const result = formatLoadReport(input);

    expect(result.report.summary.correctness).toBe('FAILED');
    expect(input).toEqual(snapshot);
  });

  test('reports zero percentiles when every attempt is transient', () => {
    const result = formatLoadReport({
      ...VALID_INPUT,
      traffic: {
        ...VALID_INPUT.traffic,
        completed: 0,
        terminalLatencyMs: [],
      },
      outcomes: {
        ...VALID_INPUT.outcomes,
        processed: 0,
        rejected: 0,
        pendingReference: 0,
        idempotentReplay: 0,
        conflict: 0,
        transientError: 10,
      },
    });

    expect(result.report.latencyMs).toEqual({ samples: 0, p50: 0, p95: 0, p99: 0 });
    expect(result.report.summary).toEqual({
      correctness: 'PASSED',
      throughputPerSecond: 0,
      errorRatePercent: 100,
    });
  });

  test.each([
    ['missing required input', {}],
    [
      'inconsistent terminal counts',
      { ...VALID_INPUT, traffic: { ...VALID_INPUT.traffic, completed: 8 } },
    ],
    [
      'incomplete correctness evidence',
      {
        ...VALID_INPUT,
        correctness: { checks: VALID_INPUT.correctness.checks.slice(0, -1) },
      },
    ],
    [
      'inconsistent transport counts',
      { ...VALID_INPUT, traffic: { ...VALID_INPUT.traffic, http: 5 } },
    ],
    [
      'unsafe report metadata',
      {
        ...VALID_INPUT,
        metadata: { ...VALID_INPUT.metadata, name: 'https://unsafe.example/report' },
      },
    ],
    ['unknown fields', { ...VALID_INPUT, rawPayload: { private: true } }],
  ])('rejects %s explicitly without echoing input values', (_label, input) => {
    expect(() => formatLoadReport(input)).toThrow(/^Invalid load report input:/);

    try {
      formatLoadReport(input);
    } catch (error) {
      expect(String(error)).not.toContain('unsafe.example');
      expect(String(error)).not.toContain('private');
    }
  });
});
