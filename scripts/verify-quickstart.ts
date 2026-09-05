import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  createDockerCommand,
  detectDockerRuntime,
  executeVerificationCommand,
  type CommandSpec,
} from './verify-challenge.js';

interface QuickstartStep {
  readonly id: string;
  readonly timeoutMs: number;
  readonly command: CommandSpec;
}

interface QuickstartStepResult {
  readonly id: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly exitCode: number | null;
  readonly durationMs: number;
}

function bun(...args: readonly string[]): CommandSpec {
  return { executable: 'bun', args };
}

function safeRunId(value: string | undefined): string {
  if (value !== undefined && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    return value;
  }
  return `quickstart-${crypto.randomUUID()}`;
}

async function run(): Promise<number> {
  const repositoryRoot = resolve(process.cwd());
  const runId = safeRunId(process.env.QUICKSTART_RUN_ID);
  let runtime;
  try {
    runtime = await detectDockerRuntime({ repositoryRoot });
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : 'Docker detection failed');
    return 1;
  }

  const steps: readonly QuickstartStep[] = [
    {
      id: 'infrastructure',
      timeoutMs: 300_000,
      command: createDockerCommand(runtime, [
        'compose',
        'up',
        '-d',
        '--wait',
        'postgres',
        'localstack',
      ]),
    },
    { id: 'migrations', timeoutMs: 300_000, command: bun('run', 'migration:up') },
    { id: 'distributed-load', timeoutMs: 600_000, command: bun('run', 'test:load') },
    {
      id: 'reconciliation',
      timeoutMs: 300_000,
      command: bun('run', 'verify:reconciliation'),
    },
    { id: 'evidence', timeoutMs: 120_000, command: bun('run', 'verify:evidence') },
  ];

  const results: QuickstartStepResult[] = [];
  let failed = false;
  for (const step of steps) {
    if (failed) {
      results.push({ id: step.id, status: 'skipped', exitCode: null, durationMs: 0 });
      continue;
    }
    const startedAt = performance.now();
    const exitCode = await executeVerificationCommand(step.command, step.timeoutMs);
    const status = exitCode === 0 ? 'passed' : 'failed';
    results.push({
      id: step.id,
      status,
      exitCode,
      durationMs: Math.round(performance.now() - startedAt),
    });
    failed = status === 'failed';
  }

  const status = results.every(({ status: stepStatus }) => stepStatus === 'passed')
    ? 'PASSED'
    : 'FAILED';
  const summary = {
    schemaVersion: 1,
    runId,
    status,
    dockerRuntime: runtime.kind,
    steps: results,
  };
  const directory = join(repositoryRoot, 'artifacts', 'quickstart', runId);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
    writeFile(
      join(directory, 'summary.md'),
      [
        '# Quickstart verification',
        '',
        `- Run: \`${runId}\``,
        `- Status: **${status}**`,
        `- Docker runtime: \`${runtime.kind}\``,
        '',
        '| Step | Status | Duration (s) | Exit code |',
        '| --- | --- | ---: | ---: |',
        ...results.map(
          ({ id, status: stepStatus, durationMs, exitCode }) =>
            `| ${id} | ${stepStatus} | ${(durationMs / 1_000).toFixed(3)} | ${exitCode === null ? '-' : String(exitCode)} |`,
        ),
        '',
      ].join('\n'),
      'utf8',
    ),
  ]);
  return status === 'PASSED' ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await run();
}
