import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { createTestEnvironment } from '../support/test-environment.js';

const testEnvironment = createTestEnvironment();
const sqsClient = new SQSClient({
  region: testEnvironment.configuration.AWS_REGION,
  ...(testEnvironment.configuration.SQS_ENDPOINT === undefined
    ? {}
    : { endpoint: testEnvironment.configuration.SQS_ENDPOINT }),
  credentials: {
    accessKeyId: testEnvironment.configuration.AWS_ACCESS_KEY_ID,
    secretAccessKey: testEnvironment.configuration.AWS_SECRET_ACCESS_KEY,
  },
});

const redrivePolicySchema = z.object({
  deadLetterTargetArn: z.string().min(1),
  maxReceiveCount: z.string().regex(/^\d+$/),
});

function applyTestEnvironment(): void {
  for (const [key, value] of Object.entries(testEnvironment.variables)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

async function getQueueAttributes(queueUrl: string) {
  const response = await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['All'],
    }),
  );

  return response.Attributes ?? {};
}

afterAll(() => {
  sqsClient.destroy();
});

describe('service bootstrap', () => {
  test('starts the NestJS application on an isolated port', async () => {
    applyTestEnvironment();
    const { AppModule } = await import('../../src/app.module.js');
    const application = await NestFactory.create(AppModule, { logger: false });

    try {
      await application.listen(0, '127.0.0.1');
      const response = await fetch(await application.getUrl());

      expect(response.status).toBe(404);
    } finally {
      await application.close();
    }
  }, 30_000);

  test('connects to PostgreSQL with the application configuration', async () => {
    applyTestEnvironment();
    const { createMikroOrmConfig } =
      await import('../../src/bootstrap/configuration/mikro-orm.config.js');
    const orm = await MikroORM.init(createMikroOrmConfig(testEnvironment.configuration));

    try {
      const rows = await orm.em.getConnection().execute<{ alive: number }[]>('select 1 as alive');

      expect(rows).toEqual([{ alive: 1 }]);
    } finally {
      await orm.close(true);
    }
  });

  test('creates FIFO queues and configures native command redrive', async () => {
    const [commandAttributes, deadLetterAttributes, eventAttributes] = await Promise.all([
      getQueueAttributes(testEnvironment.configuration.SQS_COMMAND_QUEUE_URL),
      getQueueAttributes(testEnvironment.configuration.SQS_COMMAND_DLQ_URL),
      getQueueAttributes(testEnvironment.configuration.SQS_EVENT_QUEUE_URL),
    ]);

    expect(commandAttributes.FifoQueue).toBe('true');
    expect(deadLetterAttributes.FifoQueue).toBe('true');
    expect(eventAttributes.FifoQueue).toBe('true');

    const redrivePolicy = redrivePolicySchema.parse(
      JSON.parse(commandAttributes.RedrivePolicy ?? '{}') as unknown,
    );
    const deadLetterQueueArn = z.string().min(1).parse(deadLetterAttributes.QueueArn);

    expect(redrivePolicy.deadLetterTargetArn).toBe(deadLetterQueueArn);
    expect(redrivePolicy.maxReceiveCount).toBe('5');
  });

  test('runs the migration command against PostgreSQL', async () => {
    const processHandle = Bun.spawn({
      cmd: [process.execPath, 'run', 'migration:up'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...testEnvironment.variables,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, standardOutput, standardError] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);

    expect(`${standardOutput}\n${standardError}`).not.toContain('Error');
    expect(exitCode).toBe(0);
  });
});
