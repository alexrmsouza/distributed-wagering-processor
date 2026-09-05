import { randomUUID } from 'node:crypto';

import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import {
  createSqsClient,
  createSqsQueueConfiguration,
} from '../../src/messaging/infrastructure/sqs-client.factory.js';
import { WagerCommandConsumer } from '../../src/messaging/infrastructure/wager-command.consumer.js';
import { WagerCommandMapper } from '../../src/messaging/infrastructure/wager-command.mapper.js';
import { SqsRetryPolicy } from '../../src/messaging/infrastructure/sqs-retry-policy.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { Money } from '../../src/shared/domain/money.js';
import { hashPayload } from '../../src/shared/domain/payload-hash.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { NOOP_WALLET_LOCK_METRICS } from '../../src/wallet/application/ports/wallet-lock-metrics.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction.js';
import { createWageringTransactionContext } from '../../src/wagering/infrastructure/persistence/wagering-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import { createTestEnvironment } from '../support/test-environment.js';

let commandQueueUrl: string;
let deadLetterQueueUrl: string;
let databaseContext: DatabaseTestContext | undefined;
let sqsClient: SQSClient;

setDefaultTimeout(60_000);

function getDatabaseContext(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

async function createQueuePair(client: SQSClient): Promise<readonly [string, string]> {
  const suffix = randomUUID();
  const deadLetter = await client.send(
    new CreateQueueCommand({
      QueueName: `wager-command-redrive-dlq-${suffix}.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  if (deadLetter.QueueUrl === undefined) {
    throw new Error('LocalStack did not return the dead-letter queue URL');
  }
  const attributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: deadLetter.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const deadLetterArn = attributes.Attributes?.QueueArn;
  if (deadLetterArn === undefined) {
    throw new Error('LocalStack did not return the dead-letter queue ARN');
  }
  const command = await client.send(
    new CreateQueueCommand({
      QueueName: `wager-command-redrive-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '1',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: deadLetterArn, maxReceiveCount: '2' }),
      },
    }),
  );
  if (command.QueueUrl === undefined) {
    throw new Error('LocalStack did not return the command queue URL');
  }
  return [command.QueueUrl, deadLetter.QueueUrl] as const;
}

async function receive(queueUrl: string, waitTimeSeconds = 1): Promise<Message | undefined> {
  const response = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: waitTimeSeconds,
      AttributeNames: ['All'],
    }),
  );
  return response.Messages?.[0];
}

function createEnvelope(input: {
  readonly messageId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly externalTransactionId?: string;
}) {
  return {
    messageId: input.messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-09-04T12:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: input.externalTransactionId ?? randomUUID(),
      idempotencyKey: `provider-a:${input.messageId}`,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: 'round-redrive',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
  } as const;
}

function createConsumer(
  processWagerTransaction: ProcessWagerTransactionUseCase,
  retryPolicy = new SqsRetryPolicy({
    baseVisibilityTimeoutSeconds: 30,
    maxVisibilityTimeoutSeconds: 3600,
  }),
): WagerCommandConsumer {
  const context = getDatabaseContext();
  const environment = createTestEnvironment({
    DATABASE_NAME: context.databaseName,
    SQS_COMMAND_QUEUE_URL: commandQueueUrl,
    SQS_COMMAND_DLQ_URL: deadLetterQueueUrl,
  });
  const transactionRunner = new MikroOrmTransactionRunner(context.orm, (entityManager) =>
    createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
  );
  return new WagerCommandConsumer({
    consumerName: 'wager-command-consumer',
    transactionRunner,
    processWagerTransaction,
    sqsClient,
    queueConfiguration: createSqsQueueConfiguration(environment.configuration),
    retryPolicy,
  });
}

async function businessRowCounts(): Promise<Record<string, string>> {
  const rows = await getDatabaseContext()
    .orm.em.getConnection()
    .execute<Record<string, string>[]>(
      `select
         (select count(*)::text from inbox_messages) as inbox_messages,
         (select count(*)::text from wager_transactions where kind <> 'OPENING') as transactions,
         (select count(*)::text from wallet_ledger_entries entry
           join wager_transactions transaction on transaction.id = entry.transaction_id
          where transaction.kind <> 'OPENING') as ledger_entries,
         (select count(*)::text from accounting_journals journal
           join wager_transactions transaction on transaction.id = journal.transaction_id
          where transaction.kind <> 'OPENING') as journals,
         (select count(*)::text from outbox_messages
           where event_type <> 'WalletOpened') as outbox_messages`,
    );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('Business row counts are unavailable');
  }
  return row;
}

beforeAll(async () => {
  const environment = createTestEnvironment();
  sqsClient = createSqsClient(environment.configuration);
  [commandQueueUrl, deadLetterQueueUrl] = await createQueuePair(sqsClient);
  databaseContext = await createDatabaseTestContext('sqs_redrive');
  await databaseContext.orm.migrator.up();
});

afterAll(async () => {
  await sqsClient.send(new DeleteQueueCommand({ QueueUrl: commandQueueUrl }));
  await sqsClient.send(new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }));
  sqsClient.destroy();
  await databaseContext?.close();
});

describe('SQS retry and native redrive', () => {
  test('uses bounded exponential visibility backoff for transient infrastructure errors', async () => {
    const retryPolicy = new SqsRetryPolicy({
      baseVisibilityTimeoutSeconds: 30,
      maxVisibilityTimeoutSeconds: 3600,
    });
    expect(retryPolicy.visibilityTimeoutSeconds(1)).toBe(30);
    expect(retryPolicy.visibilityTimeoutSeconds(2)).toBe(60);
    expect(retryPolicy.visibilityTimeoutSeconds(8)).toBe(3600);
    expect(retryPolicy.visibilityTimeoutSeconds(100)).toBe(3600);

    const playerId = randomUUID();
    const walletRunner = new MikroOrmTransactionRunner(
      getDatabaseContext().orm,
      createWalletTransactionContext,
    );
    const wallet = await new CreateWalletUseCase(walletRunner).execute({
      playerId,
      initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
    });
    const envelope = createEnvelope({ messageId: randomUUID(), playerId, walletId: wallet.id });
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: commandQueueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: envelope.messageId,
      }),
    );
    const message = await receive(commandQueueUrl);
    if (message === undefined) {
      throw new Error('LocalStack did not deliver the retry command');
    }
    const transientUseCase = {
      executeInContext: () =>
        Promise.reject(
          Object.assign(new Error('Database connection was interrupted'), {
            classification: 'TRANSIENT_INFRASTRUCTURE',
          }),
        ),
    } as unknown as ProcessWagerTransactionUseCase;
    const consumer = createConsumer(transientUseCase, retryPolicy);

    await consumer.processMessage(message);

    expect(await receive(commandQueueUrl, 0)).toBeUndefined();
    expect(await businessRowCounts()).toEqual({
      inbox_messages: '0',
      transactions: '0',
      ledger_entries: '0',
      journals: '0',
      outbox_messages: '0',
    });
    if (message.ReceiptHandle !== undefined) {
      await sqsClient.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: commandQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      const cleanupMessage = await receive(commandQueueUrl);
      if (cleanupMessage?.ReceiptHandle !== undefined) {
        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: commandQueueUrl,
            ReceiptHandle: cleanupMessage.ReceiptHandle,
          }),
        );
      }
    }
  });

  test('leaves malformed envelopes for native FIFO redrive without creating business rows', async () => {
    const malformedBody = '{"messageId":"malformed",';
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: commandQueueUrl,
        MessageBody: malformedBody,
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );
    const context = getDatabaseContext();
    const runner = new MikroOrmTransactionRunner(context.orm, (entityManager) =>
      createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
    );
    const consumer = createConsumer(new ProcessWagerTransactionUseCase(runner));

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const message = await receive(commandQueueUrl);
      if (message === undefined) {
        throw new Error(`LocalStack did not deliver malformed attempt ${String(delivery + 1)}`);
      }
      await consumer.processMessage(message);
    }

    let deadLetter: Message | undefined;
    for (let attempt = 0; attempt < 10 && deadLetter === undefined; attempt += 1) {
      await receive(commandQueueUrl, 0);
      deadLetter = await receive(deadLetterQueueUrl, 1);
    }

    expect(deadLetter?.Body).toBe(malformedBody);
    expect(await businessRowCounts()).toEqual({
      inbox_messages: '0',
      transactions: '0',
      ledger_entries: '0',
      journals: '0',
      outbox_messages: '0',
    });
    if (deadLetter?.ReceiptHandle !== undefined) {
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: deadLetterQueueUrl,
          ReceiptHandle: deadLetter.ReceiptHandle,
        }),
      );
    }
  });

  test('acknowledges an exact Inbox replay of a durably persisted FAILED outcome', async () => {
    const context = getDatabaseContext();
    const walletRunner = new MikroOrmTransactionRunner(context.orm, createWalletTransactionContext);
    const wallet = await new CreateWalletUseCase(walletRunner).execute({
      playerId: randomUUID(),
      initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
    });
    const envelope = createEnvelope({
      messageId: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
    });
    const mapped = WagerCommandMapper.map(JSON.stringify(envelope));
    const createdAt = new Date('2026-09-04T12:00:00.000Z');
    const transactionId = randomUUID();
    const pending = WagerTransaction.create({
      id: transactionId,
      providerId: envelope.data.providerId,
      externalTransactionId: envelope.data.externalTransactionId,
      idempotencyKey: envelope.data.idempotencyKey,
      payloadHash: hashPayload({
        providerId: envelope.data.providerId,
        externalTransactionId: envelope.data.externalTransactionId,
        playerId: envelope.data.playerId,
        walletId: envelope.data.walletId,
        roundId: envelope.data.roundId,
        gameId: envelope.data.gameId,
        kind: envelope.data.kind,
        money: envelope.data.money,
        referenceExternalTransactionId: null,
      }),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: envelope.data.roundId,
      gameId: envelope.data.gameId,
      kind: 'BET',
      amount: Money.create(envelope.data.money),
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      createdAt,
    });
    const runner = new MikroOrmTransactionRunner(context.orm, (entityManager) =>
      createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
    );
    await runner.run(async (transactionContext) => {
      expect(await transactionContext.wagerTransactions.insert(pending)).toBe(true);
    });
    const failedAt = new Date('2026-09-04T12:00:01.000Z');
    await runner.run(async (transactionContext) => {
      const accepted = await transactionContext.wagerTransactions.findById(transactionId, true);
      if (accepted === null) {
        throw new Error('Accepted Wager transaction fixture is unavailable');
      }
      await transactionContext.wagerTransactions.save(
        accepted.failForPermanentInfrastructure({
          observedBalance: wallet.balance,
          processedAt: failedAt,
        }),
      );
    });
    await context.orm.em.getConnection().execute(
      `insert into inbox_messages (
         consumer_name, message_id, payload_hash, transaction_id, received_at, processed_at
       ) values (?, ?, ?, ?, ?, ?)`,
      [
        'wager-command-consumer',
        envelope.messageId,
        mapped.payloadHash,
        transactionId,
        createdAt,
        failedAt,
      ],
    );
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: commandQueueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: envelope.messageId,
      }),
    );
    const message = await receive(commandQueueUrl);
    if (message === undefined) {
      throw new Error('LocalStack did not deliver the FAILED replay');
    }
    const consumer = createConsumer(new ProcessWagerTransactionUseCase(runner));

    const result = await consumer.processMessage(message);

    expect(result).toMatchObject({
      action: 'ACK',
      outcome: {
        transactionId,
        status: 'FAILED',
        balance: Money.create({ amount: '100.00', currency: 'BRL' }),
        idempotentReplay: true,
      },
    });
    expect(await receive(commandQueueUrl, 0)).toBeUndefined();
    const rows = await context.orm.em
      .getConnection()
      .execute<
        { inbox_messages: string; ledger_entries: string; journals: string; transactions: string }[]
      >(
        `select
         (select count(*)::text from inbox_messages where consumer_name = ? and message_id = ?) as inbox_messages,
         (select count(*)::text from wager_transactions where id = ? and status = 'FAILED') as transactions,
         (select count(*)::text from wallet_ledger_entries where transaction_id = ?) as ledger_entries,
         (select count(*)::text from accounting_journals where transaction_id = ?) as journals`,
        ['wager-command-consumer', envelope.messageId, transactionId, transactionId, transactionId],
      );
    expect(rows[0]).toEqual({
      inbox_messages: '1',
      transactions: '1',
      ledger_entries: '0',
      journals: '0',
    });
  });
});
