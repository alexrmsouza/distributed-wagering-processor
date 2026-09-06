import { randomUUID } from 'node:crypto';

import type { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { describe, expect, test } from 'bun:test';

import { IntegrationEvent } from '../../../src/messaging/domain/integration-event.js';
import type { OutboxRepository } from '../../../src/messaging/application/outbox.repository.js';
import { OutboxMessage } from '../../../src/messaging/domain/outbox-message.js';
import { SqsIntegrationEventPublisher } from '../../../src/messaging/infrastructure/integration-event.publisher.js';
import {
  OutboxWorker,
  type OutboxTransactionContext,
} from '../../../src/messaging/infrastructure/outbox.worker.js';
import type { Clock } from '../../../src/shared/application/clock.js';
import type { TransactionRunner } from '../../../src/shared/application/transaction-runner.js';

const NOW = new Date('2026-09-04T18:00:00.000Z');

class FixedClock implements Clock {
  public now(): Date {
    return new Date(NOW);
  }
}

class FakeOutboxRepository implements OutboxRepository {
  public readonly transactionBound = true as const;
  public readonly reschedules: {
    outboxId: string;
    leaseToken: string;
    attempts: number;
    nextAttemptAt: Date;
  }[] = [];
  public readonly publications: {
    outboxId: string;
    leaseToken: string;
    publishedAt: Date;
  }[] = [];
  public readonly blocks: {
    outboxId: string;
    leaseToken: string;
    attempts: number;
    reason: 'PERMANENT_PUBLISH_FAILURE' | 'RETRY_EXHAUSTED';
    blockedAt: Date;
  }[] = [];

  public constructor(private readonly claims: readonly OutboxMessage[]) {}

  public insert(): Promise<void> {
    return Promise.resolve();
  }

  public claimDue(): Promise<readonly OutboxMessage[]> {
    return Promise.resolve(this.claims);
  }

  public markPublished(outboxId: string, leaseToken: string, publishedAt: Date): Promise<boolean> {
    this.publications.push({ outboxId, leaseToken, publishedAt });
    return Promise.resolve(true);
  }

  public reschedule(
    outboxId: string,
    leaseToken: string,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    this.reschedules.push({ outboxId, leaseToken, attempts, nextAttemptAt });
    return Promise.resolve(true);
  }

  public block(
    outboxId: string,
    leaseToken: string,
    attempts: number,
    reason: 'PERMANENT_PUBLISH_FAILURE' | 'RETRY_EXHAUSTED',
    blockedAt: Date,
  ): Promise<boolean> {
    this.blocks.push({ outboxId, leaseToken, attempts, reason, blockedAt });
    return Promise.resolve(true);
  }

  public replayBlocked(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function runner(outbox: OutboxRepository): TransactionRunner<OutboxTransactionContext> {
  return {
    run: (work) => work({ outbox }),
  };
}

function message(attempts = 0): OutboxMessage {
  const event = IntegrationEvent.create({
    eventId: randomUUID(),
    eventType: 'WalletBalanceChanged',
    aggregateId: randomUUID(),
    correlationId: randomUUID(),
    occurredAt: NOW,
    version: 1,
    data: { walletId: randomUUID() },
  });
  const queued = OutboxMessage.enqueue({ id: randomUUID(), event });
  return OutboxMessage.rehydrate({ ...queued.toState(), attempts });
}

describe('OutboxWorker', () => {
  test('persists deterministic exponential retry state with a bounded delay', async () => {
    const pending = message(4);
    const repository = new FakeOutboxRepository([pending]);
    const worker = new OutboxWorker(
      runner(repository),
      {
        publish: () => Promise.reject(new Error('SQS unavailable')),
      },
      {
        clock: new FixedClock(),
        generateLeaseToken: () => '5dd10cac-f167-43f1-908f-c601f00ad0f1',
        retryBaseDelayMs: 1_000,
        retryMaxDelayMs: 4_000,
      },
    );

    expect(await worker.runOnce()).toEqual({
      claimed: 1,
      published: 0,
      rescheduled: 1,
      blocked: 0,
      skipped: 0,
    });
    expect(repository.reschedules).toEqual([
      {
        outboxId: pending.id,
        leaseToken: '5dd10cac-f167-43f1-908f-c601f00ad0f1',
        attempts: 5,
        nextAttemptAt: new Date('2026-09-04T18:00:04.000Z'),
      },
    ]);
    expect(repository.publications).toEqual([]);
  });

  test('blocks a permanent publishing failure using only a sanitized reason', async () => {
    const pending = message();
    const repository = new FakeOutboxRepository([pending]);
    const error = Object.assign(new Error('credential and payload must not be persisted'), {
      $metadata: { httpStatusCode: 403 },
    });
    const worker = new OutboxWorker(
      runner(repository),
      { publish: () => Promise.reject(error) },
      { clock: new FixedClock(), generateLeaseToken: () => randomUUID() },
    );

    expect(await worker.runOnce()).toEqual({
      claimed: 1,
      published: 0,
      rescheduled: 0,
      blocked: 1,
      skipped: 0,
    });
    expect(repository.blocks).toHaveLength(1);
    expect(repository.blocks[0]).toMatchObject({
      outboxId: pending.id,
      attempts: 1,
      reason: 'PERMANENT_PUBLISH_FAILURE',
      blockedAt: NOW,
    });
    expect(repository.blocks[0]?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(repository.blocks)).not.toContain(error.message);
  });

  test('blocks a retryable failure after the configured attempt limit', async () => {
    const pending = message(2);
    const repository = new FakeOutboxRepository([pending]);
    const worker = new OutboxWorker(
      runner(repository),
      { publish: () => Promise.reject(new Error('temporary failure')) },
      {
        clock: new FixedClock(),
        generateLeaseToken: () => randomUUID(),
        maxAttempts: 3,
      },
    );

    const result = await worker.runOnce();

    expect(result.blocked).toBe(1);
    expect(repository.blocks[0]?.reason).toBe('RETRY_EXHAUSTED');
    expect(repository.reschedules).toEqual([]);
  });
});

describe('SqsIntegrationEventPublisher', () => {
  test('publishes the persisted envelope with FIFO aggregate and event identities', async () => {
    const pending = message();
    const commands: SendMessageCommand[] = [];
    const sqsClient = {
      send: (command: SendMessageCommand) => {
        commands.push(command);
        return Promise.resolve({ MessageId: 'sqs-message-1' });
      },
    } as unknown as SQSClient;

    await new SqsIntegrationEventPublisher(
      sqsClient,
      'http://localhost:4566/000000000000/events.fifo',
    ).publish(pending);

    const state = pending.toState();
    expect(commands).toHaveLength(1);
    expect(commands[0]?.input).toEqual({
      QueueUrl: 'http://localhost:4566/000000000000/events.fifo',
      MessageBody: JSON.stringify(state.payload),
      MessageGroupId: state.aggregateId,
      MessageDeduplicationId: state.eventId,
    });
  });
});
