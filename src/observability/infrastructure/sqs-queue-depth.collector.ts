import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import type {
  OperationalMetrics,
  QueueDepthMetricQueue,
} from '../application/operational-metrics.js';

interface SqsQueueAttributesClient {
  send(
    command: GetQueueAttributesCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown>;
  destroy(): void;
}

export interface MonitoredSqsQueue {
  readonly name: QueueDepthMetricQueue;
  readonly url: string;
}

export interface SqsQueueDepthCollectorOptions {
  readonly queues: readonly MonitoredSqsQueue[];
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly now?: () => Date;
}

interface QueueAttributesResponse {
  readonly Attributes?: Readonly<Record<string, string | undefined>>;
}

function positiveSafeInteger(value: string | undefined, attribute: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new TypeError(`${attribute} is not a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${attribute} exceeds the safe integer range`);
  }
  return parsed;
}

export class SqsQueueDepthCollector implements OnModuleInit, OnModuleDestroy {
  readonly #queues: readonly MonitoredSqsQueue[];
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  #timer: ReturnType<typeof setInterval> | undefined;
  #activeCollection: Promise<void> | undefined;
  #destroyed = false;

  public constructor(
    private readonly sqsClient: SqsQueueAttributesClient,
    private readonly metrics: OperationalMetrics,
    options: SqsQueueDepthCollectorOptions,
  ) {
    if (options.queues.length === 0) {
      throw new TypeError('At least one SQS queue must be monitored');
    }
    if (
      new Set(options.queues.map(({ name }) => name)).size !== options.queues.length ||
      options.queues.some(({ url }) => url.trim().length === 0)
    ) {
      throw new TypeError('Monitored SQS queues must have unique names and normalized URLs');
    }
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new RangeError('Queue metrics interval must be a positive safe integer');
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new RangeError('Queue metrics timeout must be a positive safe integer');
    }

    this.#queues = Object.freeze([...options.queues]);
    this.#intervalMs = options.intervalMs;
    this.#timeoutMs = options.timeoutMs;
    this.#now = options.now ?? (() => new Date());
  }

  public onModuleInit(): void {
    if (this.#destroyed || this.#timer !== undefined) {
      return;
    }
    void this.collectOnce();
    this.#timer = setInterval(() => void this.collectOnce(), this.#intervalMs);
    this.#timer.unref();
  }

  public collectOnce(): Promise<void> {
    if (this.#destroyed) {
      return Promise.resolve();
    }
    if (this.#activeCollection !== undefined) {
      return this.#activeCollection;
    }

    const collection = Promise.all(this.#queues.map((queue) => this.collectQueue(queue))).then(
      () => undefined,
    );
    this.#activeCollection = collection.finally(() => {
      this.#activeCollection = undefined;
    });
    return this.#activeCollection;
  }

  public async onModuleDestroy(): Promise<void> {
    this.#destroyed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#activeCollection;
    this.sqsClient.destroy();
  }

  private async collectQueue(queue: MonitoredSqsQueue): Promise<void> {
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = this.sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: queue.url,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed',
          ],
        }),
        { abortSignal: abortController.signal },
      ) as Promise<QueueAttributesResponse>;
      const response = await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            abortController.abort();
            reject(new Error('SQS queue depth collection timed out'));
          }, this.#timeoutMs);
        }),
      ]);
      const attributes = response.Attributes;
      const available = positiveSafeInteger(
        attributes?.ApproximateNumberOfMessages,
        'ApproximateNumberOfMessages',
      );
      const inFlight = positiveSafeInteger(
        attributes?.ApproximateNumberOfMessagesNotVisible,
        'ApproximateNumberOfMessagesNotVisible',
      );
      const delayed = positiveSafeInteger(
        attributes?.ApproximateNumberOfMessagesDelayed,
        'ApproximateNumberOfMessagesDelayed',
      );

      this.safely(() => {
        this.metrics.setQueueDepth(queue.name, 'available', available);
      });
      this.safely(() => {
        this.metrics.setQueueDepth(queue.name, 'in_flight', inFlight);
      });
      this.safely(() => {
        this.metrics.setQueueDepth(queue.name, 'delayed', delayed);
      });
      this.safely(() => {
        this.metrics.setQueueDepthLastSuccess(
          queue.name,
          Math.floor(this.#now().getTime() / 1_000),
        );
      });
    } catch {
      this.safely(() => {
        this.metrics.recordQueueDepthCollectionFailure(queue.name);
      });
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private safely(operation: () => void): void {
    try {
      operation();
    } catch {
      // Telemetry must never affect application correctness.
    }
  }
}
