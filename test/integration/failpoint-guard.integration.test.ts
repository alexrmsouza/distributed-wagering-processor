import { describe, expect, test } from 'bun:test';
import { Registry } from 'prom-client';

import { ObservableFailpointPort } from '../../src/observability/application/failpoint-observability.js';
import { PrometheusMetrics } from '../../src/observability/infrastructure/prometheus-metrics.js';
import { RedactingJsonLogger } from '../../src/observability/infrastructure/redacting-json.logger.js';
import { FailpointController } from '../../src/shared/infrastructure/failpoints/failpoint-controller.js';
import {
  FAILPOINT_NAMES,
  type FailpointName,
} from '../../src/shared/infrastructure/failpoints/failpoint.port.js';

function armFailpoint(
  failpoint: FailpointName,
  configuration: { readonly enabled: boolean; readonly environment: string },
): FailpointController {
  const controller = FailpointController.create(configuration);
  controller.arm(failpoint);
  return controller;
}

async function captureTriggerError(
  controller: FailpointController,
  failpoint: FailpointName,
): Promise<Error> {
  try {
    await controller.trigger(failpoint);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error(`Expected ${failpoint} to trigger`);
}

describe('failpoint runtime guard', () => {
  for (const failpoint of FAILPOINT_NAMES) {
    test(`${failpoint} is unavailable in development`, () => {
      expect(() => armFailpoint(failpoint, { enabled: true, environment: 'development' })).toThrow(
        'Failpoints are only available in test environments',
      );
    });

    test(`${failpoint} is unavailable in production`, () => {
      expect(() => armFailpoint(failpoint, { enabled: true, environment: 'production' })).toThrow(
        'Failpoints are only available in test environments',
      );
    });

    test(`${failpoint} is unavailable in any other non-test environment`, () => {
      expect(() => armFailpoint(failpoint, { enabled: true, environment: 'staging' })).toThrow(
        'Failpoints are only available in test environments',
      );
    });

    test(`${failpoint} is unavailable when explicitly disabled in test`, () => {
      expect(() => armFailpoint(failpoint, { enabled: false, environment: 'test' })).toThrow(
        'Failpoints are disabled',
      );
    });

    test(`${failpoint} remains one-shot in explicitly enabled test configuration`, async () => {
      const controller = armFailpoint(failpoint, { enabled: true, environment: 'test' });

      expect(await captureTriggerError(controller, failpoint)).toMatchObject({ failpoint });
      await controller.trigger(failpoint);
    });
  }
});

test('records only safe predefined diagnostics when a test failpoint activates', async () => {
  const registry = new Registry();
  const metrics = new PrometheusMetrics(registry);
  const lines: string[] = [];
  const logger = new RedactingJsonLogger({ write: (line) => lines.push(line) });
  const controller = FailpointController.create({ enabled: true, environment: 'test' });
  controller.arm('after_financial_commit_before_sqs_ack');
  const observable = new ObservableFailpointPort({
    failpoints: controller,
    logger,
    metrics,
    instanceId: 'test-instance',
  });

  let activationError: unknown;
  try {
    await observable.trigger('after_financial_commit_before_sqs_ack');
  } catch (error: unknown) {
    activationError = error;
  }
  expect(activationError).toBeInstanceOf(Error);
  expect((activationError as Error).message).toContain('Failpoint triggered');

  expect(await registry.metrics()).toContain(
    'failpoint_activations_total{name="after_financial_commit_before_sqs_ack"} 1',
  );
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
    event: 'failpoint_activated',
    correlationId: 'test-instance',
    failpoint: 'after_financial_commit_before_sqs_ack',
    stage: 'after_financial_commit_before_sqs_ack',
  });
});
