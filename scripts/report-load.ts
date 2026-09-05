import { z } from 'zod';

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const duration = z.number().nonnegative();
const durationSamples = z.array(duration);

const safeIdentifier = z.string().regex(SAFE_IDENTIFIER);

const correctnessCheckNames = [
  'HOT_WALLET_SERIALIZATION',
  'INDEPENDENT_WALLET_PROGRESS',
  'HTTP_SQS_CONVERGENCE',
  'DUPLICATE_SUPPRESSION',
  'PENDING_REFERENCE_RESOLUTION',
  'FINANCIAL_INVARIANTS',
  'EVENTUAL_OUTBOX_PUBLICATION',
] as const;

const metadataSchema = z
  .object({
    name: safeIdentifier,
    seed: safeIdentifier,
    generatedAt: z.string().regex(ISO_TIMESTAMP),
    measurementDurationMs: z.number().positive(),
    warmupDurationMs: duration,
    concurrency: positiveInteger,
    processCount: z.number().int().min(3),
  })
  .strict();

const environmentSchema = z
  .object({
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    bunVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
    dockerMode: z.enum(['DIRECT', 'WSL2']),
  })
  .strict();

const trafficSchema = z
  .object({
    attempted: positiveInteger,
    completed: nonNegativeInteger,
    http: nonNegativeInteger,
    sqs: nonNegativeInteger,
    terminalLatencyMs: durationSamples,
  })
  .strict();

const outcomesSchema = z
  .object({
    processed: nonNegativeInteger,
    rejected: nonNegativeInteger,
    pendingReference: nonNegativeInteger,
    idempotentReplay: nonNegativeInteger,
    conflict: nonNegativeInteger,
    failed: nonNegativeInteger,
    sqsAccepted: nonNegativeInteger,
    transientError: nonNegativeInteger,
  })
  .strict();

const duplicatesSchema = z
  .object({
    deliveries: nonNegativeInteger,
    suppressed: nonNegativeInteger,
    logicalEffects: nonNegativeInteger,
  })
  .strict();

const locksSchema = z
  .object({
    conflicts: nonNegativeInteger,
    waits: nonNegativeInteger,
    waitDurationMs: z.array(duration),
  })
  .strict();

const outboxSchema = z
  .object({
    published: nonNegativeInteger,
    pending: nonNegativeInteger,
    lagMs: z.array(duration),
  })
  .strict();

const reconciliationSchema = z
  .object({
    walletsChecked: positiveInteger,
    consistentWallets: nonNegativeInteger,
    divergentWallets: nonNegativeInteger,
  })
  .strict();

const correctnessSchema = z
  .object({
    checks: z
      .array(
        z
          .object({
            name: z.enum(correctnessCheckNames),
            passed: z.boolean(),
          })
          .strict(),
      )
      .length(correctnessCheckNames.length),
  })
  .strict();

const loadReportInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    metadata: metadataSchema,
    environment: environmentSchema,
    traffic: trafficSchema,
    outcomes: outcomesSchema,
    duplicates: duplicatesSchema,
    locks: locksSchema,
    outbox: outboxSchema,
    reconciliation: reconciliationSchema,
    correctness: correctnessSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.traffic.http + input.traffic.sqs !== input.traffic.attempted) {
      context.addIssue({
        code: 'custom',
        path: ['traffic'],
        message: 'transport counts must equal attempted operations',
      });
    }

    if (input.traffic.terminalLatencyMs.length !== input.traffic.completed) {
      context.addIssue({
        code: 'custom',
        path: ['traffic', 'terminalLatencyMs'],
        message: 'latency samples must equal completed operations',
      });
    }

    const terminalOutcomes =
      input.outcomes.processed +
      input.outcomes.rejected +
      input.outcomes.pendingReference +
      input.outcomes.idempotentReplay +
      input.outcomes.conflict +
      input.outcomes.failed +
      input.outcomes.sqsAccepted;

    if (terminalOutcomes !== input.traffic.completed) {
      context.addIssue({
        code: 'custom',
        path: ['outcomes'],
        message: 'terminal outcomes must equal completed operations',
      });
    }

    if (input.traffic.completed + input.outcomes.transientError !== input.traffic.attempted) {
      context.addIssue({
        code: 'custom',
        path: ['outcomes', 'transientError'],
        message: 'completed operations and transient errors must equal attempted operations',
      });
    }

    if (input.duplicates.suppressed > input.duplicates.deliveries) {
      context.addIssue({
        code: 'custom',
        path: ['duplicates', 'suppressed'],
        message: 'suppressed duplicates cannot exceed duplicate deliveries',
      });
    }

    if (input.duplicates.logicalEffects > input.duplicates.deliveries) {
      context.addIssue({
        code: 'custom',
        path: ['duplicates', 'logicalEffects'],
        message: 'logical effects cannot exceed duplicate deliveries',
      });
    }

    if (input.locks.waitDurationMs.length !== input.locks.waits) {
      context.addIssue({
        code: 'custom',
        path: ['locks', 'waitDurationMs'],
        message: 'lock wait samples must equal lock waits',
      });
    }

    if (input.outbox.lagMs.length !== input.outbox.published) {
      context.addIssue({
        code: 'custom',
        path: ['outbox', 'lagMs'],
        message: 'Outbox lag samples must equal published events',
      });
    }

    if (
      input.reconciliation.consistentWallets + input.reconciliation.divergentWallets !==
      input.reconciliation.walletsChecked
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reconciliation'],
        message: 'reconciliation counts must equal checked wallets',
      });
    }

    const uniqueChecks = new Set(input.correctness.checks.map(({ name }) => name));
    if (uniqueChecks.size !== input.correctness.checks.length) {
      context.addIssue({
        code: 'custom',
        path: ['correctness', 'checks'],
        message: 'correctness checks must be unique',
      });
    }
  });

export type LoadReportInput = z.infer<typeof loadReportInputSchema>;
type CorrectnessCheckName = (typeof correctnessCheckNames)[number];

interface PercentileSummary {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

interface LoadReport {
  readonly schemaVersion: 1;
  readonly runtimeMetadata: {
    readonly generatedAt: string;
    readonly timestampKind: 'RUNTIME_INPUT';
  };
  readonly scenario: Omit<LoadReportInput['metadata'], 'generatedAt'>;
  readonly environment: LoadReportInput['environment'];
  readonly summary: {
    readonly correctness: 'PASSED' | 'FAILED';
    readonly throughputPerSecond: number;
    readonly errorRatePercent: number;
  };
  readonly traffic: Omit<LoadReportInput['traffic'], 'terminalLatencyMs'>;
  readonly latencyMs: PercentileSummary;
  readonly outcomes: LoadReportInput['outcomes'];
  readonly duplicates: LoadReportInput['duplicates'] & {
    readonly suppressionRatePercent: number;
  };
  readonly locks: Omit<LoadReportInput['locks'], 'waitDurationMs'> & {
    readonly waitDurationMs: PercentileSummary;
  };
  readonly outbox: Omit<LoadReportInput['outbox'], 'lagMs'> & {
    readonly lagMs: PercentileSummary;
  };
  readonly reconciliation: LoadReportInput['reconciliation'];
  readonly correctness: {
    readonly checks: readonly {
      readonly name: CorrectnessCheckName;
      readonly passed: boolean;
    }[];
  };
}

export interface FormattedLoadReport {
  readonly report: LoadReport;
  readonly json: string;
  readonly markdown: string;
}

class LoadReportValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LoadReportValidationError';
  }
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round((numerator / denominator) * 100);
}

function percentile(samples: readonly number[], percentileValue: number): number {
  if (samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  const result = sorted.at(index);
  return result === undefined ? 0 : round(result);
}

function summarizePercentiles(samples: readonly number[]): PercentileSummary {
  return {
    samples: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
  };
}

function parseInput(input: unknown): LoadReportInput {
  const result = loadReportInputSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  const path = issue?.path.length === 0 ? 'root' : issue?.path.join('.');
  const code = issue?.code ?? 'invalid_input';
  throw new LoadReportValidationError(`Invalid load report input: ${path ?? 'root'} (${code})`);
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function formatCountRows(entries: readonly (readonly [string, number])[]): string {
  return entries.map(([label, value]) => `| ${label} | ${String(value)} |`).join('\n');
}

function buildMarkdown(report: LoadReport): string {
  const checkRows = report.correctness.checks
    .map(({ name, passed }) => `| ${name} | ${passed ? 'PASS' : 'FAIL'} |`)
    .join('\n');

  return `# Load Verification Report

## Runtime metadata

| Field | Value |
| --- | --- |
| Scenario | ${report.scenario.name} |
| Seed | ${report.scenario.seed} |
| Runtime timestamp (input metadata) | ${report.runtimeMetadata.generatedAt} |
| Measurement | ${formatNumber(report.scenario.measurementDurationMs)} ms |
| Warm-up | ${formatNumber(report.scenario.warmupDurationMs)} ms |
| Concurrency | ${String(report.scenario.concurrency)} |
| Service processes | ${String(report.scenario.processCount)} |
| Platform | ${report.environment.platform}/${report.environment.architecture} |
| Bun | ${report.environment.bunVersion} |
| Docker access | ${report.environment.dockerMode} |

## Summary

| Metric | Value |
| --- | --- |
| Correctness | ${report.summary.correctness} |
| Throughput | ${formatNumber(report.summary.throughputPerSecond)} ops/s |
| Error rate | ${formatNumber(report.summary.errorRatePercent)}% |
| Attempted | ${String(report.traffic.attempted)} |
| Completed | ${String(report.traffic.completed)} |
| HTTP | ${String(report.traffic.http)} |
| SQS | ${String(report.traffic.sqs)} |

## Caller latency

| Percentile | Value |
| --- | --- |
| Samples | ${String(report.latencyMs.samples)} |
| p50 | ${formatNumber(report.latencyMs.p50)} ms |
| p95 | ${formatNumber(report.latencyMs.p95)} ms |
| p99 | ${formatNumber(report.latencyMs.p99)} ms |

## Outcomes

| Outcome | Count |
| --- | --- |
${formatCountRows([
  ['Processed', report.outcomes.processed],
  ['Rejected', report.outcomes.rejected],
  ['Pending reference', report.outcomes.pendingReference],
  ['Idempotent replay', report.outcomes.idempotentReplay],
  ['Conflict', report.outcomes.conflict],
  ['Failed', report.outcomes.failed],
  ['SQS accepted', report.outcomes.sqsAccepted],
  ['Transient error', report.outcomes.transientError],
])}

## Duplicate suppression

| Metric | Value |
| --- | --- |
| Deliveries | ${String(report.duplicates.deliveries)} |
| Suppressed | ${String(report.duplicates.suppressed)} |
| Logical effects | ${String(report.duplicates.logicalEffects)} |
| Suppression rate | ${formatNumber(report.duplicates.suppressionRatePercent)}% |

## Lock behavior

| Metric | Value |
| --- | --- |
| Conflicts | ${String(report.locks.conflicts)} |
| Waits | ${String(report.locks.waits)} |
| Wait p50 | ${formatNumber(report.locks.waitDurationMs.p50)} ms |
| Wait p95 | ${formatNumber(report.locks.waitDurationMs.p95)} ms |
| Wait p99 | ${formatNumber(report.locks.waitDurationMs.p99)} ms |

## Outbox

| Metric | Value |
| --- | --- |
| Published | ${String(report.outbox.published)} |
| Pending | ${String(report.outbox.pending)} |
| Lag p50 | ${formatNumber(report.outbox.lagMs.p50)} ms |
| Lag p95 | ${formatNumber(report.outbox.lagMs.p95)} ms |
| Lag p99 | ${formatNumber(report.outbox.lagMs.p99)} ms |

## Reconciliation

| Metric | Value |
| --- | --- |
| Wallets checked | ${String(report.reconciliation.walletsChecked)} |
| Consistent wallets | ${String(report.reconciliation.consistentWallets)} |
| Divergent wallets | ${String(report.reconciliation.divergentWallets)} |

## Correctness checks

| Check | Status |
| --- | --- |
${checkRows}
`;
}

export function formatLoadReport(input: unknown): FormattedLoadReport {
  const parsed = parseInput(input);
  const checkOrder = Object.fromEntries(
    correctnessCheckNames.map((name, index) => [name, index]),
  ) as Record<CorrectnessCheckName, number>;
  const checks = [...parsed.correctness.checks].sort(
    (left, right) => checkOrder[left.name] - checkOrder[right.name],
  );
  const correctnessPassed =
    checks.every(({ passed }) => passed) && parsed.reconciliation.divergentWallets === 0;

  const report: LoadReport = {
    schemaVersion: 1,
    runtimeMetadata: {
      generatedAt: parsed.metadata.generatedAt,
      timestampKind: 'RUNTIME_INPUT',
    },
    scenario: {
      name: parsed.metadata.name,
      seed: parsed.metadata.seed,
      measurementDurationMs: parsed.metadata.measurementDurationMs,
      warmupDurationMs: parsed.metadata.warmupDurationMs,
      concurrency: parsed.metadata.concurrency,
      processCount: parsed.metadata.processCount,
    },
    environment: parsed.environment,
    summary: {
      correctness: correctnessPassed ? 'PASSED' : 'FAILED',
      throughputPerSecond: round(
        parsed.traffic.completed / (parsed.metadata.measurementDurationMs / 1_000),
      ),
      errorRatePercent: percentage(parsed.outcomes.transientError, parsed.traffic.attempted),
    },
    traffic: {
      attempted: parsed.traffic.attempted,
      completed: parsed.traffic.completed,
      http: parsed.traffic.http,
      sqs: parsed.traffic.sqs,
    },
    latencyMs: summarizePercentiles(parsed.traffic.terminalLatencyMs),
    outcomes: parsed.outcomes,
    duplicates: {
      ...parsed.duplicates,
      suppressionRatePercent: percentage(
        parsed.duplicates.suppressed,
        parsed.duplicates.deliveries,
      ),
    },
    locks: {
      conflicts: parsed.locks.conflicts,
      waits: parsed.locks.waits,
      waitDurationMs: summarizePercentiles(parsed.locks.waitDurationMs),
    },
    outbox: {
      published: parsed.outbox.published,
      pending: parsed.outbox.pending,
      lagMs: summarizePercentiles(parsed.outbox.lagMs),
    },
    reconciliation: parsed.reconciliation,
    correctness: { checks },
  };

  return {
    report,
    json: `${JSON.stringify(report, null, 2)}\n`,
    markdown: buildMarkdown(report),
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return await Bun.file(path).json();
  } catch {
    throw new LoadReportValidationError('Invalid load report input: unable to read JSON file');
  }
}

async function runReportLoadCli(args: readonly string[]): Promise<number> {
  const [inputPath, outputBase] = args;
  if (inputPath === undefined) {
    console.error('Usage: bun scripts/report-load.ts <input.json> [output-base]');
    return 1;
  }

  try {
    const formatted = formatLoadReport(await readJsonFile(inputPath));
    if (outputBase === undefined) {
      process.stdout.write(formatted.markdown);
      return 0;
    }

    await Promise.all([
      Bun.write(`${outputBase}.json`, formatted.json),
      Bun.write(`${outputBase}.md`, formatted.markdown),
    ]);
    return 0;
  } catch (error) {
    const message =
      error instanceof LoadReportValidationError
        ? error.message
        : 'Unable to format load report safely';
    console.error(message);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runReportLoadCli(Bun.argv.slice(2));
}
