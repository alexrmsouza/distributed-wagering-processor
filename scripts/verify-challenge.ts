import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'not_applicable';

export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface DockerRuntime {
  readonly kind: 'direct' | 'wsl-ubuntu';
  readonly repositoryRoot: string;
}

export interface VerificationStep {
  readonly id: string;
  readonly mandatory: boolean;
  readonly timeoutMs: number;
  readonly commands: readonly CommandSpec[];
}

export interface VerificationResult {
  readonly id: string;
  readonly status: VerificationStatus;
  readonly durationMs: number;
  readonly exitCode: number | null;
}

export interface VerificationEvaluation {
  readonly status: 'PASSED' | 'FAILED';
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly notApplicable: number;
}

interface DetectDockerRuntimeOptions {
  readonly platform?: NodeJS.Platform;
  readonly repositoryRoot?: string;
  readonly probe?: (command: CommandSpec) => Promise<number>;
}

interface VerificationSummaryInput {
  readonly runId: string;
  readonly dockerRuntime: DockerRuntime['kind'];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly results: readonly VerificationResult[];
}

export const LOCAL_VERIFICATION_ENVIRONMENT = Object.freeze({
  NODE_ENV: 'test',
  DATABASE_HOST: '127.0.0.1',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'wagering',
  DATABASE_USER: 'wagering',
  DATABASE_PASSWORD: 'wagering',
  DATABASE_SSL: 'false',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_ENDPOINT: 'http://127.0.0.1:4566',
  SQS_COMMAND_QUEUE_URL: 'http://127.0.0.1:4566/000000000000/wager-transactions.fifo',
  SQS_COMMAND_DLQ_URL: 'http://127.0.0.1:4566/000000000000/wager-transactions-dlq.fifo',
  SQS_EVENT_QUEUE_URL: 'http://127.0.0.1:4566/000000000000/wager-integration-events.fifo',
  SQS_CONSUMER_ENABLED: 'false',
  OUTBOX_PUBLISHER_ENABLED: 'false',
});

function windowsPathToWsl(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (drive === null) {
    return normalized;
  }
  const driveLetter = drive[1];
  const remainder = drive[2];
  if (driveLetter === undefined || remainder === undefined) {
    return normalized;
  }
  return `/mnt/${driveLetter.toLowerCase()}/${remainder}`;
}

export function createDockerCommand(runtime: DockerRuntime, args: readonly string[]): CommandSpec {
  if (runtime.kind === 'direct') {
    return { executable: 'docker', args };
  }
  return {
    executable: 'wsl.exe',
    args: [
      '-d',
      'Ubuntu',
      '--cd',
      windowsPathToWsl(runtime.repositoryRoot),
      '--',
      'docker',
      ...args,
    ],
  };
}

export async function executeVerificationCommand(
  command: CommandSpec,
  timeoutMs: number,
  output: 'inherit' | 'ignore' = 'inherit',
): Promise<number> {
  const subprocess = Bun.spawn([command.executable, ...command.args], {
    cwd: process.cwd(),
    env: { ...process.env, ...LOCAL_VERIFICATION_ENVIRONMENT },
    stdin: 'ignore',
    stdout: output,
    stderr: output,
  });
  const timeout = setTimeout(() => {
    subprocess.kill();
  }, timeoutMs);
  try {
    return await subprocess.exited;
  } finally {
    clearTimeout(timeout);
  }
}

async function defaultDockerProbe(command: CommandSpec): Promise<number> {
  return executeVerificationCommand(command, 10_000, 'ignore');
}

export async function detectDockerRuntime(
  options: DetectDockerRuntimeOptions = {},
): Promise<DockerRuntime> {
  const platform = options.platform ?? process.platform;
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const probe = options.probe ?? defaultDockerProbe;
  const direct: CommandSpec = { executable: 'docker', args: ['info'] };
  if ((await probe(direct)) === 0) {
    return Object.freeze({ kind: 'direct', repositoryRoot });
  }
  if (platform !== 'win32') {
    throw new Error('Docker daemon is unavailable');
  }
  const wsl = createDockerCommand({ kind: 'wsl-ubuntu', repositoryRoot }, ['info']);
  if ((await probe(wsl)) === 0) {
    return Object.freeze({ kind: 'wsl-ubuntu', repositoryRoot });
  }
  throw new Error('Docker is unavailable directly and through Ubuntu WSL 2');
}

function bun(...args: readonly string[]): CommandSpec {
  return { executable: 'bun', args };
}

export function createVerificationPlan(runtime: DockerRuntime): readonly VerificationStep[] {
  const step = (
    id: string,
    timeoutMs: number,
    ...commands: readonly CommandSpec[]
  ): VerificationStep => ({ id, mandatory: true, timeoutMs, commands });

  return Object.freeze([
    step(
      'dependencies',
      300_000,
      createDockerCommand(runtime, ['compose', 'up', '-d', '--wait', 'postgres', 'localstack']),
      bun('install', '--frozen-lockfile'),
    ),
    step('format', 120_000, bun('run', 'format:check')),
    step('lint', 180_000, bun('run', 'lint')),
    step('typecheck', 180_000, bun('run', 'typecheck')),
    step('build', 180_000, bun('run', 'build')),
    step('unit', 600_000, bun('run', 'test:unit')),
    step('integration', 1_200_000, bun('run', 'test:integration')),
    step(
      'migrations',
      600_000,
      bun('run', 'migration:up'),
      bun('test', 'test/integration/migrations.integration.test.ts'),
    ),
    step(
      'constraints',
      600_000,
      bun('test', 'test/integration/schema-constraints.integration.test.ts'),
    ),
    step(
      'http-contracts',
      600_000,
      bun(
        'test',
        'test/integration/wallets.http.integration.test.ts',
        'test/integration/wagering.http.integration.test.ts',
      ),
    ),
    step(
      'localstack',
      600_000,
      bun(
        'test',
        'test/integration/sqs-redrive.integration.test.ts',
        'test/integration/cross-transport-idempotency.integration.test.ts',
        'test/integration/integration-event-inbox.integration.test.ts',
      ),
    ),
    step('concurrency', 1_200_000, bun('run', 'test:concurrency')),
    step(
      'resilience',
      1_200_000,
      bun(
        'test',
        'test/resilience/sqs-shutdown.resilience.test.ts',
        'test/resilience/sqs-commit-ack-crash.resilience.test.ts',
        'test/resilience/outbox-publication-crash.resilience.test.ts',
      ),
    ),
    step('reconciliation', 300_000, bun('run', 'verify:reconciliation')),
    step('load', 900_000, bun('run', 'test:load')),
    step('evidence', 120_000, bun('run', 'verify:evidence')),
    step('quickstart', 900_000, bun('test', 'test/resilience/verify-challenge.resilience.test.ts')),
  ]);
}

export function evaluateVerificationResults(
  results: readonly VerificationResult[],
): VerificationEvaluation {
  const count = (status: VerificationStatus) =>
    results.filter((result) => result.status === status).length;
  const failed = count('failed');
  const skipped = count('skipped');
  return Object.freeze({
    status: failed === 0 && skipped === 0 ? 'PASSED' : 'FAILED',
    passed: count('passed'),
    failed,
    skipped,
    notApplicable: count('not_applicable'),
  });
}

export function renderVerificationSummary(input: VerificationSummaryInput): {
  readonly json: string;
  readonly markdown: string;
} {
  const evaluation = evaluateVerificationResults(input.results);
  const payload = {
    schemaVersion: 1,
    runId: input.runId,
    status: evaluation.status,
    dockerRuntime: input.dockerRuntime,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    counts: {
      passed: evaluation.passed,
      failed: evaluation.failed,
      skipped: evaluation.skipped,
      notApplicable: evaluation.notApplicable,
    },
    results: input.results,
  };
  const rows = input.results
    .map(
      ({ id, status, durationMs, exitCode }) =>
        `| ${id} | ${status} | ${(durationMs / 1_000).toFixed(3)} | ${exitCode === null ? '-' : String(exitCode)} |`,
    )
    .join('\n');
  return Object.freeze({
    json: `${JSON.stringify(payload, null, 2)}\n`,
    markdown: [
      '# Challenge verification',
      '',
      `- Run: \`${input.runId}\``,
      `- Status: **${evaluation.status}**`,
      `- Docker runtime: \`${input.dockerRuntime}\``,
      `- Started: \`${input.startedAt}\``,
      `- Completed: \`${input.completedAt}\``,
      '',
      '| Gate | Status | Duration (s) | Exit code |',
      '| --- | --- | ---: | ---: |',
      rows,
      '',
    ].join('\n'),
  });
}

async function runStep(step: VerificationStep): Promise<VerificationResult> {
  const startedAt = performance.now();
  for (const command of step.commands) {
    const exitCode = await executeVerificationCommand(command, step.timeoutMs);
    if (exitCode !== 0) {
      return Object.freeze({
        id: step.id,
        status: 'failed',
        durationMs: Math.round(performance.now() - startedAt),
        exitCode,
      });
    }
  }
  return Object.freeze({
    id: step.id,
    status: 'passed',
    durationMs: Math.round(performance.now() - startedAt),
    exitCode: 0,
  });
}

function safeRunId(value: string | undefined): string {
  if (value !== undefined && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    return value;
  }
  return `verify-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
}

async function persistSummary(
  root: string,
  runId: string,
  summary: { readonly json: string; readonly markdown: string },
): Promise<void> {
  const directory = join(root, 'artifacts', 'verification', runId);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'summary.json'), summary.json, 'utf8'),
    writeFile(join(directory, 'summary.md'), summary.markdown, 'utf8'),
  ]);
}

async function runCli(): Promise<number> {
  const repositoryRoot = resolve(process.cwd());
  const runId = safeRunId(process.env.VERIFY_CHALLENGE_RUN_ID);
  const startedAt = new Date().toISOString();
  let runtime: DockerRuntime;
  try {
    runtime = await detectDockerRuntime({ repositoryRoot });
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : 'Infrastructure verification failed');
    return 1;
  }

  const plan = createVerificationPlan(runtime);
  const results: VerificationResult[] = [];
  let failed = false;
  for (const step of plan) {
    if (failed) {
      results.push({ id: step.id, status: 'skipped', durationMs: 0, exitCode: null });
      continue;
    }
    console.log(`[verify:challenge] ${step.id}`);
    const result = await runStep(step);
    results.push(result);
    failed = result.status === 'failed';
  }

  const summary = renderVerificationSummary({
    runId,
    dockerRuntime: runtime.kind,
    startedAt,
    completedAt: new Date().toISOString(),
    results,
  });
  await persistSummary(repositoryRoot, runId, summary);
  process.stdout.write(summary.markdown);
  return evaluateVerificationResults(results).status === 'PASSED' ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await runCli();
}
