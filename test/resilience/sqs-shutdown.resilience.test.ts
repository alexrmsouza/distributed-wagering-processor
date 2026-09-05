import { randomUUID } from 'node:crypto';

import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { Money } from '../../src/shared/domain/money.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import {
  createIsolatedCommandQueue,
  createSqsClient,
  sendWagerCommand,
  startConsumerProcess,
  type ConsumerProcessMode,
  type IsolatedCommandQueue,
  type RunningConsumerProcess,
  type WagerCommandEnvelope,
} from '../support/sqs-consumer-process.js';
import { createTestEnvironment } from '../support/test-environment.js';

const CONSUMER_NAME = 'wager-command-consumer';

let commandQueue: IsolatedCommandQueue | undefined;
let databaseContext: DatabaseTestContext | undefined;
const processes = new Set<RunningConsumerProcess>();
const baseEnvironment = createTestEnvironment();
const sqsClient = createSqsClient(baseEnvironment.variables);

setDefaultTimeout(120_000);

function getDatabaseContext(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

function getCommandQueue(): IsolatedCommandQueue {
  if (commandQueue === undefined) {
    throw new Error('Command queue is unavailable');
  }
  return commandQueue;
}

async function startConsumer(mode: ConsumerProcessMode): Promise<RunningConsumerProcess> {
  const context = getDatabaseContext();
  const queue = getCommandQueue();
  const environment = createTestEnvironment({
    DATABASE_NAME: context.databaseName,
    SQS_COMMAND_QUEUE_URL: queue.commandQueueUrl,
  });
  const processHandle = startConsumerProcess({
    commandQueueUrl: queue.commandQueueUrl,
    consumerName: CONSUMER_NAME,
    environment: environment.variables,
    gracePeriodMs: 5_000,
    mode,
  });
  processes.add(processHandle);
  await processHandle.waitForMarker('READY');
  return processHandle;
}

async function signalAndWaitForStop(processHandle: RunningConsumerProcess): Promise<void> {
  const stoppedMarker = processHandle.waitForMarker('STOPPED');
  const exitCode = processHandle.stop();
  await stoppedMarker;
  expect(await exitCode).toBe(0);
  processes.delete(processHandle);
}

async function createFundedWallet(): Promise<{ playerId: string; walletId: string }> {
  const runner = new MikroOrmTransactionRunner(
    getDatabaseContext().orm,
    createWalletTransactionContext,
  );
  const playerId = randomUUID();
  const wallet = await new CreateWalletUseCase(runner).execute({
    playerId,
    initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
  });
  return { playerId, walletId: wallet.id };
}

function createBetEnvelope(
  playerId: string,
  walletId: string,
  label: string,
): WagerCommandEnvelope {
  return Object.freeze({
    messageId: `message-${label}-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: `transaction-${label}-${randomUUID()}`,
      idempotencyKey: `idempotency-${label}-${randomUUID()}`,
      playerId,
      walletId,
      roundId: `round-${label}`,
      gameId: 'fortune-chimp',
      kind: 'BET' as const,
      money: { amount: '25.00', currency: 'BRL' },
    },
  });
}

async function persistedCommandCounts(
  envelope: WagerCommandEnvelope,
): Promise<{ inbox_messages: string; ledger_entries: string; transactions: string }> {
  const rows = await getDatabaseContext()
    .orm.em.getConnection()
    .execute<{ inbox_messages: string; ledger_entries: string; transactions: string }[]>(
      `select
         (select count(*)::text from inbox_messages
           where consumer_name = ? and message_id = ? and processed_at is not null)
           as inbox_messages,
         (select count(*)::text from wager_transactions
           where provider_id = ? and external_transaction_id = ?) as transactions,
         (select count(*)::text
            from wallet_ledger_entries entry
            join wager_transactions transaction on transaction.id = entry.transaction_id
           where transaction.provider_id = ? and transaction.external_transaction_id = ?)
           as ledger_entries`,
      [
        CONSUMER_NAME,
        envelope.messageId,
        envelope.data.providerId,
        envelope.data.externalTransactionId,
        envelope.data.providerId,
        envelope.data.externalTransactionId,
      ],
    );
  const row = rows.at(0);
  if (row === undefined) {
    throw new Error('Persisted command counts are unavailable');
  }
  return row;
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('sqs_shutdown');
  await databaseContext.orm.migrator.up();
  commandQueue = await createIsolatedCommandQueue(sqsClient, 'shutdown');
});

afterAll(async () => {
  await Promise.all(
    [...processes].map(async (processHandle) => {
      if (processHandle.handle.exitCode === null) {
        await processHandle.stop();
      } else {
        await processHandle.handle.exited;
      }
    }),
  );
  await commandQueue?.delete();
  sqsClient.destroy();
  await databaseContext?.close();
});

describe('SQS consumer coordinated shutdown', () => {
  test('stops polling and acknowledges committed work within the grace period', async () => {
    const wallet = await createFundedWallet();
    const committedEnvelope = createBetEnvelope(wallet.playerId, wallet.walletId, 'committed');
    const queuedAfterSignal = createBetEnvelope(wallet.playerId, wallet.walletId, 'not-polled');
    const consumer = await startConsumer('pause-after-commit');

    await sendWagerCommand(sqsClient, getCommandQueue().commandQueueUrl, committedEnvelope);
    await consumer.waitForMarker('COMMITTED_BEFORE_ACK');
    await sendWagerCommand(sqsClient, getCommandQueue().commandQueueUrl, queuedAfterSignal);

    const acknowledged = consumer.waitForMarker(
      'RECEIPT_TRANSITION',
      (marker) =>
        marker.messageId === committedEnvelope.messageId && marker.state === 'acknowledged',
    );
    const shutdownStartedAt = performance.now();
    await signalAndWaitForStop(consumer);
    await acknowledged;
    expect(performance.now() - shutdownStartedAt).toBeLessThan(5_500);
    expect(await persistedCommandCounts(committedEnvelope)).toEqual({
      inbox_messages: '1',
      transactions: '1',
      ledger_entries: '1',
    });

    const queuedMessage = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: getCommandQueue().commandQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 10,
      }),
    );
    const message = queuedMessage.Messages?.at(0);
    expect(message?.Body).toBe(JSON.stringify(queuedAfterSignal));
    expect(message?.ReceiptHandle).toBeDefined();
    await sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: getCommandQueue().commandQueueUrl,
        ReceiptHandle: message?.ReceiptHandle,
      }),
    );
  });

  test('releases uncommitted work for one safe redelivery', async () => {
    const wallet = await createFundedWallet();
    const envelope = createBetEnvelope(wallet.playerId, wallet.walletId, 'uncommitted');
    const interruptedConsumer = await startConsumer('pause-before-commit');

    await sendWagerCommand(sqsClient, getCommandQueue().commandQueueUrl, envelope);
    await interruptedConsumer.waitForMarker('BEFORE_FINANCIAL_COMMIT');
    const released = interruptedConsumer.waitForMarker(
      'RECEIPT_TRANSITION',
      (marker) => marker.messageId === envelope.messageId && marker.state === 'released',
    );
    await signalAndWaitForStop(interruptedConsumer);
    await released;
    expect(await persistedCommandCounts(envelope)).toEqual({
      inbox_messages: '0',
      transactions: '0',
      ledger_entries: '0',
    });

    const replacement = await startConsumer('normal');
    await replacement.waitForMarker(
      'RECEIPT_TRANSITION',
      (marker) => marker.messageId === envelope.messageId && marker.state === 'acknowledged',
      30_000,
    );
    expect(await persistedCommandCounts(envelope)).toEqual({
      inbox_messages: '1',
      transactions: '1',
      ledger_entries: '1',
    });
    await signalAndWaitForStop(replacement);
  });
});
