import { describe, expect, test } from 'bun:test';

async function loadVerificationModule() {
  const exists = await Bun.file('scripts/verify-challenge.ts').exists();
  if (!exists) {
    expect(exists).toBeTrue();
  }
  return import('../../../scripts/verify-challenge.js');
}

describe('challenge verification orchestrator', () => {
  test('prefers a directly reachable Docker daemon', async () => {
    const { detectDockerRuntime } = await loadVerificationModule();
    const probes: string[] = [];

    const runtime = await detectDockerRuntime({
      platform: 'win32',
      repositoryRoot: 'C:\\repo',
      probe: (command: { readonly executable: string }) => {
        probes.push(command.executable);
        return Promise.resolve(0);
      },
    });

    expect(runtime.kind).toBe('direct');
    expect(probes).toEqual(['docker']);
  });

  test('uses only the explicit Ubuntu WSL fallback when direct Docker is unavailable', async () => {
    const { detectDockerRuntime } = await loadVerificationModule();
    const probes: { readonly executable: string; readonly args: readonly string[] }[] = [];

    const runtime = await detectDockerRuntime({
      platform: 'win32',
      repositoryRoot: 'C:\\workspace\\challenge',
      probe: (command: { readonly executable: string; readonly args: readonly string[] }) => {
        probes.push(command);
        return Promise.resolve(command.executable === 'docker' ? 1 : 0);
      },
    });

    expect(runtime.kind).toBe('wsl-ubuntu');
    expect(probes).toHaveLength(2);
    expect(probes[1]?.executable).toBe('wsl.exe');
    expect(probes[1]?.args).toContain('Ubuntu');
    expect(probes[1]?.args.join(' ')).toContain('/mnt/c/workspace/challenge');
  });

  test('defines every mandatory evaluator gate and rejects skipped gates', async () => {
    const { createVerificationPlan, evaluateVerificationResults } = await loadVerificationModule();
    const plan = createVerificationPlan({ kind: 'direct', repositoryRoot: 'C:\\repo' });

    expect(plan.map(({ id }: { readonly id: string }) => id)).toEqual([
      'dependencies',
      'format',
      'lint',
      'typecheck',
      'build',
      'openapi',
      'unit',
      'integration',
      'migrations',
      'constraints',
      'http-contracts',
      'localstack',
      'concurrency',
      'resilience',
      'reconciliation',
      'load',
      'evidence',
      'quickstart',
    ]);
    expect(plan.every(({ mandatory }: { readonly mandatory: boolean }) => mandatory)).toBeTrue();

    const results = plan.map((step: { readonly id: string }, index: number) => ({
      id: step.id,
      status: index === 0 ? ('skipped' as const) : ('passed' as const),
      durationMs: 10,
      exitCode: index === 0 ? null : 0,
    }));
    expect(evaluateVerificationResults(results).status).toBe('FAILED');
  });

  test('renders stable safe Markdown and JSON summaries', async () => {
    const { renderVerificationSummary } = await loadVerificationModule();
    const summary = renderVerificationSummary({
      runId: 'verify-seed-1',
      dockerRuntime: 'wsl-ubuntu',
      startedAt: '2026-09-05T12:00:00.000Z',
      completedAt: '2026-09-05T12:01:00.000Z',
      results: [
        { id: 'unit', status: 'passed', durationMs: 1250, exitCode: 0 },
        { id: 'load', status: 'failed', durationMs: 2500, exitCode: 1 },
      ],
    });

    const json = JSON.parse(summary.json) as { readonly status: string };
    expect(json.status).toBe('FAILED');
    expect(summary.markdown).toContain('| unit | passed | 1.250 | 0 |');
    expect(summary.markdown).toContain('| load | failed | 2.500 | 1 |');
    expect(summary.markdown).not.toContain('postgresql://');
    expect(summary.markdown).not.toContain('receiptHandle');
  });
});
