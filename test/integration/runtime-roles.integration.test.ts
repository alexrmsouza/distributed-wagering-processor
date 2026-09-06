import { NestFactory } from '@nestjs/core';
import { expect, test } from 'bun:test';

import { OutboxWorker } from '../../src/messaging/infrastructure/outbox.worker.js';
import { WagerCommandConsumer } from '../../src/messaging/infrastructure/wager-command.consumer.js';
import { SqsQueueDepthCollector } from '../../src/observability/infrastructure/sqs-queue-depth.collector.js';
import { PendingReferenceWorker } from '../../src/wagering/infrastructure/pending-reference.worker.js';
import { WageringController } from '../../src/wagering/presentation/wagering.controller.js';
import { createDatabaseTestContext } from '../support/database-test-context.js';
import { createTestEnvironment } from '../support/test-environment.js';

function applyEnvironment(databaseName: string): void {
  const environment = createTestEnvironment({ DATABASE_NAME: databaseName });
  for (const [key, value] of Object.entries(environment.variables)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

function hasProvider(
  application: {
    get<T>(type: abstract new (...arguments_: never[]) => T, options: { strict: false }): T;
  },
  provider: abstract new (...arguments_: never[]) => unknown,
): boolean {
  try {
    application.get(provider, { strict: false });
    return true;
  } catch {
    return false;
  }
}

test('boots API and worker roles with isolated provider surfaces', async () => {
  const database = await createDatabaseTestContext('runtime_roles_test');

  try {
    await database.orm.migrator.up();
    applyEnvironment(database.databaseName);
    const [{ ApiAppModule }, { WorkerAppModule }] = await Promise.all([
      import('../../src/api-app.module.js'),
      import('../../src/worker-app.module.js'),
    ]);

    const api = await NestFactory.create(ApiAppModule, { abortOnError: false, logger: false });
    await api.listen(0, '127.0.0.1');
    try {
      const response = await fetch(`${await api.getUrl()}/health/live`);
      expect(response.status).toBe(200);
      expect(hasProvider(api, WageringController)).toBe(true);
      expect(hasProvider(api, PendingReferenceWorker)).toBe(false);
      expect(hasProvider(api, WagerCommandConsumer)).toBe(false);
      expect(hasProvider(api, OutboxWorker)).toBe(false);
      expect(hasProvider(api, SqsQueueDepthCollector)).toBe(true);
    } finally {
      await api.close();
    }

    const worker = await NestFactory.createApplicationContext(WorkerAppModule, {
      abortOnError: false,
      logger: false,
    });
    try {
      expect(hasProvider(worker, PendingReferenceWorker)).toBe(true);
      expect(hasProvider(worker, WagerCommandConsumer)).toBe(true);
      expect(hasProvider(worker, OutboxWorker)).toBe(true);
      expect(hasProvider(worker, WageringController)).toBe(false);
      expect(hasProvider(worker, SqsQueueDepthCollector)).toBe(false);
    } finally {
      await worker.close();
    }
  } finally {
    await database.close();
  }
});
