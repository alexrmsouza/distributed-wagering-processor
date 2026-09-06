import { describe, expect, test } from 'bun:test';

interface QueueDepthMetrics {
  setQueueDepth(queue: string, state: string, value: number): void;
  recordQueueDepthCollectionFailure(queue: string): void;
  setQueueDepthLastSuccess(queue: string, timestampSeconds: number): void;
}

interface QueueDepthCollector {
  collectOnce(): Promise<void>;
  onModuleDestroy(): Promise<void>;
}

type CollectorConstructor = new (
  client: {
    send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
    destroy(): void;
  },
  metrics: QueueDepthMetrics,
  options: {
    readonly queues: readonly { readonly name: string; readonly url: string }[];
    readonly intervalMs: number;
    readonly timeoutMs: number;
    readonly now?: () => Date;
  },
) => QueueDepthCollector;

const MODULE_PATH = '../../../src/observability/infrastructure/sqs-queue-depth.collector.js';

async function loadCollector(): Promise<CollectorConstructor | undefined> {
  try {
    const module = (await import(MODULE_PATH)) as {
      readonly SqsQueueDepthCollector?: CollectorConstructor;
    };
    return module.SqsQueueDepthCollector;
  } catch {
    return undefined;
  }
}

describe('SqsQueueDepthCollector', () => {
  test('maps complete SQS snapshots to bounded queue and state labels', async () => {
    const Collector = await loadCollector();
    expect(Collector).toBeDefined();

    const observations: string[] = [];
    const successes: string[] = [];
    const client = {
      send: () =>
        Promise.resolve({
          Attributes: {
            ApproximateNumberOfMessages: '7',
            ApproximateNumberOfMessagesNotVisible: '2',
            ApproximateNumberOfMessagesDelayed: '1',
          },
        }),
      destroy: () => undefined,
    };
    const metrics: QueueDepthMetrics = {
      setQueueDepth: (queue, state, value) =>
        observations.push(`${queue}:${state}:${String(value)}`),
      recordQueueDepthCollectionFailure: () => undefined,
      setQueueDepthLastSuccess: (queue, value) => successes.push(`${queue}:${String(value)}`),
    };
    if (Collector === undefined) {
      throw new Error('Queue depth collector is unavailable');
    }
    const collector = new Collector(client, metrics, {
      queues: [{ name: 'command', url: 'http://sqs.local/command' }],
      intervalMs: 15_000,
      timeoutMs: 2_000,
      now: () => new Date('2026-09-05T12:00:00.000Z'),
    });

    await collector.collectOnce();

    expect(observations).toEqual([
      'command:available:7',
      'command:in_flight:2',
      'command:delayed:1',
    ]);
    expect(successes).toEqual(['command:1788609600']);
    await collector.onModuleDestroy();
  });

  test('contains collection failures and preserves the previous snapshot', async () => {
    const Collector = await loadCollector();
    expect(Collector).toBeDefined();

    let shouldFail = false;
    const observations: string[] = [];
    const failures: string[] = [];
    let destroyed = false;
    const client = {
      send: () => {
        if (shouldFail) {
          return Promise.reject(new Error('connection failed with secret details'));
        }
        return Promise.resolve({
          Attributes: {
            ApproximateNumberOfMessages: '3',
            ApproximateNumberOfMessagesNotVisible: '0',
            ApproximateNumberOfMessagesDelayed: '0',
          },
        });
      },
      destroy: () => {
        destroyed = true;
      },
    };
    const metrics: QueueDepthMetrics = {
      setQueueDepth: (queue, state, value) =>
        observations.push(`${queue}:${state}:${String(value)}`),
      recordQueueDepthCollectionFailure: (queue) => failures.push(queue),
      setQueueDepthLastSuccess: () => undefined,
    };
    if (Collector === undefined) {
      throw new Error('Queue depth collector is unavailable');
    }
    const collector = new Collector(client, metrics, {
      queues: [{ name: 'event', url: 'http://sqs.local/event' }],
      intervalMs: 15_000,
      timeoutMs: 2_000,
    });

    await collector.collectOnce();
    shouldFail = true;
    await collector.collectOnce();

    expect(observations).toHaveLength(3);
    expect(failures).toEqual(['event']);
    await collector.onModuleDestroy();
    expect(destroyed).toBe(true);
  });
});
