import { describe, expect, test } from 'bun:test';

import {
  deriveThreeInstancePorts,
  startThreeInstanceHarness,
} from '../../support/three-instance-harness.js';
import { createTestEnvironment } from '../../support/test-environment.js';

const TEST_SERVICE_PROCESS = `
const instanceId = process.env.THREE_INSTANCE_ID;
const hostname = process.env.APP_HOST;
const port = Number(process.env.APP_PORT);
const server = Bun.serve({
  hostname,
  port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health/live' || path === '/health/ready') {
      return Response.json({ instanceId, status: 'ok' });
    }
    return new Response('Not found', { status: 404 });
  },
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void server.stop(true).then(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
await new Promise(() => undefined);
`;

describe('Three-instance harness', () => {
  test('derives a stable collision-safe port group from the run identity', () => {
    const first = deriveThreeInstancePorts('stable-load-run');
    const second = deriveThreeInstancePorts('stable-load-run');

    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(3);
    expect(first.every((port) => port > 0 && port <= 65_535)).toBeTrue();
  });

  test('starts, observes, and stops three real service processes', async () => {
    const environment = createTestEnvironment();
    const harness = await startThreeInstanceHarness({
      environment: environment.variables,
      runId: `harness-unit-${String(process.pid)}`,
      serviceCommand: [process.execPath, '--eval', TEST_SERVICE_PROCESS],
      shutdownTimeoutMs: 2_000,
      startupTimeoutMs: 10_000,
    });

    try {
      expect(harness.instances).toHaveLength(3);
      expect(new Set(harness.instances.map((instance) => instance.processId)).size).toBe(3);
      expect(new Set(harness.instances.map((instance) => instance.port)).size).toBe(3);

      const reports = await Promise.all(
        harness.instances.map(async (instance) => {
          const response = await fetch(`${instance.baseUrl}/health/ready`);
          return (await response.json()) as { instanceId: string; status: string };
        }),
      );

      expect(reports).toEqual(
        harness.instances.map((instance) => ({
          instanceId: instance.instanceId,
          status: 'ok',
        })),
      );
    } finally {
      await harness.stop();
    }

    expect(harness.diagnostics().every((diagnostic) => diagnostic.state === 'stopped')).toBeTrue();
  });
});
