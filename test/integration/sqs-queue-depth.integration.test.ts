import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Registry } from 'prom-client';

import { PrometheusMetrics } from '../../src/observability/infrastructure/prometheus-metrics.js';
import { SqsQueueDepthCollector } from '../../src/observability/infrastructure/sqs-queue-depth.collector.js';

const client = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const queueUrls: string[] = [];
const monitoredQueues: Partial<Record<'available' | 'delayed' | 'in_flight', string>> = {};

async function createQueue(role: string): Promise<string> {
  const name = `depth-${role}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const response = await client.send(new CreateQueueCommand({ QueueName: name }));
  if (response.QueueUrl === undefined) {
    throw new Error(`LocalStack did not return the ${role} queue URL`);
  }
  queueUrls.push(response.QueueUrl);
  return response.QueueUrl;
}

beforeAll(async () => {
  const [available, inFlight, delayed] = await Promise.all([
    createQueue('available'),
    createQueue('inflight'),
    createQueue('delayed'),
  ]);
  monitoredQueues.available = available;
  monitoredQueues.in_flight = inFlight;
  monitoredQueues.delayed = delayed;
  await Promise.all([
    client.send(new SendMessageCommand({ QueueUrl: available, MessageBody: 'available' })),
    client.send(new SendMessageCommand({ QueueUrl: inFlight, MessageBody: 'in-flight' })),
    client.send(
      new SendMessageCommand({ QueueUrl: delayed, MessageBody: 'delayed', DelaySeconds: 60 }),
    ),
  ]);
  const received = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: inFlight,
      MaxNumberOfMessages: 1,
      VisibilityTimeout: 60,
      WaitTimeSeconds: 2,
    }),
  );
  if (received.Messages?.[0] === undefined) {
    throw new Error('LocalStack did not return the in-flight test message');
  }
});

afterAll(async () => {
  await Promise.all(queueUrls.map((QueueUrl) => client.send(new DeleteQueueCommand({ QueueUrl }))));
  client.destroy();
});

describe('SQS queue depth metrics with LocalStack', () => {
  test('reports available, in-flight, and delayed broker state with bounded labels', async () => {
    const availableQueue = monitoredQueues.available;
    const inFlightQueue = monitoredQueues.in_flight;
    const delayedQueue = monitoredQueues.delayed;
    if (availableQueue === undefined || inFlightQueue === undefined || delayedQueue === undefined) {
      throw new Error('Monitored LocalStack queues are unavailable');
    }
    const registry = new Registry();
    const metrics = new PrometheusMetrics(registry);
    const collector = new SqsQueueDepthCollector(client, metrics, {
      queues: [
        { name: 'command', url: availableQueue },
        { name: 'command_dlq', url: inFlightQueue },
        { name: 'event', url: delayedQueue },
      ],
      intervalMs: 15_000,
      timeoutMs: 2_000,
    });

    let exposition = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await collector.collectOnce();
      exposition = await registry.metrics();
      if (
        exposition.includes('sqs_queue_depth_messages{queue="command",state="available"} 1') &&
        exposition.includes('sqs_queue_depth_messages{queue="command_dlq",state="in_flight"} 1') &&
        exposition.includes('sqs_queue_depth_messages{queue="event",state="delayed"} 1')
      ) {
        break;
      }
      await Bun.sleep(100);
    }

    expect(exposition).toContain('sqs_queue_depth_messages{queue="command",state="available"} 1');
    expect(exposition).toContain(
      'sqs_queue_depth_messages{queue="command_dlq",state="in_flight"} 1',
    );
    expect(exposition).toContain('sqs_queue_depth_messages{queue="event",state="delayed"} 1');
  });
});
