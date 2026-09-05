import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const runId = `quickstart-${crypto.randomUUID()}`;
const artifactDirectory = join('artifacts', 'quickstart', runId);

describe('documented evaluator quickstart', () => {
  test('executes real infrastructure, three-process load, reconciliation, and evidence validation', async () => {
    const scriptExists = await Bun.file('scripts/verify-quickstart.ts').exists();
    expect(scriptExists).toBeTrue();

    const child = Bun.spawn(['bun', 'run', 'scripts/verify-quickstart.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        QUICKSTART_RUN_ID: runId,
        LOAD_OPERATION_COUNT: '250',
        LOAD_WARMUP_MS: '0',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => {
      child.kill();
    }, 600_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => {
      clearTimeout(timeout);
    });

    if (exitCode !== 0) {
      console.error(stdout.slice(-4_000));
      console.error(stderr.slice(-4_000));
    }
    expect(exitCode).toBe(0);

    const summary = (await Bun.file(join(artifactDirectory, 'summary.json')).json()) as {
      readonly status: string;
      readonly steps: readonly { readonly status: string }[];
    };
    expect(summary.status).toBe('PASSED');
    expect(summary.steps).toHaveLength(5);
    expect(summary.steps.every(({ status }) => status === 'passed')).toBeTrue();
  }, 620_000);
});
