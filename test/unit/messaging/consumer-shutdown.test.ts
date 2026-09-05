import {
  ChangeMessageVisibilityCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { describe, expect, test } from 'bun:test';

import type { TransactionRunner } from '../../../src/shared/application/transaction-runner.js';
import type { WageringTransactionContext } from '../../../src/wagering/application/ports/wagering-transaction-context.js';
import type { ProcessWagerTransactionUseCase } from '../../../src/wagering/application/process-wager-transaction.use-case.js';
import { ConsumerShutdownCoordinator } from '../../../src/messaging/infrastructure/consumer-shutdown.js';
import { WagerCommandConsumer } from '../../../src/messaging/infrastructure/wager-command.consumer.js';

describe('SQS consumer shutdown bounds', () => {
  test('ignores late delivery transitions after shutdown releases a receipt', () => {
    const coordinator = new ConsumerShutdownCoordinator({ gracePeriodMs: 10 });
    coordinator.register('receipt-handle', 'message-id');
    coordinator.stopAccepting();
    coordinator.transition('receipt-handle', 'released');

    expect(() => {
      coordinator.transition('receipt-handle', 'committed');
    }).not.toThrow();
    expect(coordinator.activeReceipts()).toEqual([]);
  });

  test('returns within the grace bound when receipt visibility cleanup never settles', async () => {
    let processingStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      processingStarted = resolve;
    });
    const envelope = {
      messageId: 'shutdown-bounded-message',
      type: 'WagerTransactionRequested',
      occurredAt: '2026-09-04T12:00:00.000Z',
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'shutdown-bounded-transaction',
        idempotencyKey: 'provider-a:shutdown-bounded-transaction',
        playerId: '01991a20-7b40-7000-8000-000000000001',
        walletId: '01991a20-7b40-7000-8000-000000000002',
        roundId: 'round-shutdown',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    };
    const sqsClient = {
      destroy: () => undefined,
      send: (command: unknown): Promise<unknown> => {
        if (command instanceof ReceiveMessageCommand) {
          return Promise.resolve({
            Messages: [
              {
                Body: JSON.stringify(envelope),
                MessageId: envelope.messageId,
                ReceiptHandle: 'receipt-handle',
                Attributes: { ApproximateReceiveCount: '1' },
              },
            ],
          });
        }
        if (command instanceof ChangeMessageVisibilityCommand) {
          return new Promise(() => undefined);
        }
        return Promise.resolve({});
      },
    } as unknown as SQSClient;
    const transactionRunner = {
      run: () => new Promise(() => undefined),
    } as unknown as TransactionRunner<WageringTransactionContext>;
    const shutdownCoordinator = new ConsumerShutdownCoordinator({
      gracePeriodMs: 25,
      onTransition: ({ state }) => {
        if (state === 'processing') {
          processingStarted?.();
        }
      },
    });
    const consumer = new WagerCommandConsumer({
      consumerName: 'wager-command-consumer',
      transactionRunner,
      processWagerTransaction: {} as ProcessWagerTransactionUseCase,
      sqsClient,
      queueConfiguration: { commandQueueUrl: 'http://localhost/queue' },
      shutdownCoordinator,
    });
    await consumer.start();
    await started;

    const startedAt = performance.now();
    await consumer.stop();

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(shutdownCoordinator.activeReceipts()).toEqual([]);
  });
});
