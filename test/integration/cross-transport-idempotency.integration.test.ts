import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import {
  createSqsClient,
  createSqsQueueConfiguration,
} from '../../src/messaging/infrastructure/sqs-client.factory.js';
import {
  WagerCommandConsumer,
  type WagerCommandDeliveryResult,
} from '../../src/messaging/infrastructure/wager-command.consumer.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { NOOP_WALLET_LOCK_METRICS } from '../../src/wallet/application/ports/wallet-lock-metrics.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { createWageringTransactionContext } from '../../src/wagering/infrastructure/persistence/wagering-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import { createTestEnvironment } from '../support/test-environment.js';

let application: INestApplication | undefined;
let baseUrl: string;
let commandQueueUrl: string;
let databaseContext: DatabaseTestContext | undefined;
let sqsClient: SQSClient;

setDefaultTimeout(60_000);

interface CommandData {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function getDatabaseContext(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

async function createFifoQueue(client: SQSClient, prefix: string): Promise<string> {
  const response = await client.send(
    new CreateQueueCommand({
      QueueName: `${prefix}-${randomUUID()}.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  if (response.QueueUrl === undefined) {
    throw new Error('LocalStack did not return a queue URL');
  }
  return response.QueueUrl;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: asRecord((await response.json()) as unknown) };
}

async function createWallet(initialBalance = '100.00') {
  const playerId = randomUUID();
  const response = await post('/wallets', {
    playerId,
    initialBalance: { amount: initialBalance, currency: 'BRL' },
  });
  expect(response.response.status).toBe(201);
  return { playerId, walletId: String(response.body.id) };
}

function createCommand(
  wallet: { readonly playerId: string; readonly walletId: string },
  overrides: Partial<CommandData> = {},
): CommandData {
  const externalTransactionId = randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-cross-transport',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function toHttpBody(command: CommandData): Omit<CommandData, 'idempotencyKey'> {
  return {
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money,
    ...(command.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: command.referenceExternalTransactionId }),
  };
}

function createConsumer(): WagerCommandConsumer {
  const context = getDatabaseContext();
  const environment = createTestEnvironment({
    DATABASE_NAME: context.databaseName,
    SQS_COMMAND_QUEUE_URL: commandQueueUrl,
  });
  const wageringRunner = new MikroOrmTransactionRunner(context.orm, (entityManager) =>
    createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
  );
  return new WagerCommandConsumer({
    consumerName: 'wager-command-consumer',
    transactionRunner: wageringRunner,
    processWagerTransaction: new ProcessWagerTransactionUseCase(wageringRunner),
    sqsClient,
    queueConfiguration: createSqsQueueConfiguration(environment.configuration),
  });
}

async function processThroughSqs(
  command: CommandData,
  messageId = randomUUID(),
): Promise<{ readonly messageId: string; readonly result: WagerCommandDeliveryResult }> {
  const envelope = {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-09-04T12:00:00.000Z',
    data: command,
  } as const;
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: commandQueueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: command.walletId,
      MessageDeduplicationId: messageId,
    }),
  );
  const received = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: commandQueueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 2,
      AttributeNames: ['All'],
    }),
  );
  const message = received.Messages?.[0];
  if (message === undefined) {
    throw new Error('LocalStack did not deliver the command message');
  }

  return { messageId, result: await createConsumer().processMessage(message) };
}

async function persistedCommandCounts(
  command: CommandData,
  messageId: string,
): Promise<Record<string, string>> {
  const rows = await getDatabaseContext()
    .orm.em.getConnection()
    .execute<Record<string, string>[]>(
      `select
         (select count(*)::text from inbox_messages where consumer_name = ? and message_id = ?) as inbox_messages,
         (select count(*)::text from wager_transactions where provider_id = ? and idempotency_key = ?) as transactions,
         (select count(*)::text from wallet_ledger_entries entry
           join wager_transactions transaction on transaction.id = entry.transaction_id
          where transaction.provider_id = ? and transaction.idempotency_key = ?) as ledger_entries,
         (select count(*)::text from accounting_journals journal
           join wager_transactions transaction on transaction.id = journal.transaction_id
          where transaction.provider_id = ? and transaction.idempotency_key = ?) as journals,
         (select count(*)::text from outbox_messages
           where payload -> 'data' ->> 'transactionId' =
             (select id::text from wager_transactions where provider_id = ? and idempotency_key = ?)) as outbox_messages`,
      [
        'wager-command-consumer',
        messageId,
        command.providerId,
        command.idempotencyKey,
        command.providerId,
        command.idempotencyKey,
        command.providerId,
        command.idempotencyKey,
        command.providerId,
        command.idempotencyKey,
      ],
    );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('Persisted command counts are unavailable');
  }
  return row;
}

beforeAll(async () => {
  const baseEnvironment = createTestEnvironment();
  sqsClient = createSqsClient(baseEnvironment.configuration);
  commandQueueUrl = await createFifoQueue(sqsClient, 'cross-transport');

  const [{ WalletModule }, { WageringModule }] = await Promise.all([
    import('../../src/wallet/wallet.module.js'),
    import('../../src/wagering/wagering.module.js'),
  ]);
  databaseContext = await createDatabaseTestContext('cross_transport');
  await databaseContext.orm.migrator.up();
  const environment = createTestEnvironment({
    DATABASE_NAME: databaseContext.databaseName,
    SQS_COMMAND_QUEUE_URL: commandQueueUrl,
  });
  const { createMikroOrmConfig } =
    await import('../../src/bootstrap/configuration/mikro-orm.config.js');

  @Module({
    imports: [
      MikroOrmModule.forRoot(createMikroOrmConfig(environment.configuration)),
      WalletModule,
      WageringModule,
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest uses this class as a module metadata root.
  class CrossTransportTestModule {}

  application = await NestFactory.create(CrossTransportTestModule, { logger: false });
  await application.listen(0, '127.0.0.1');
  baseUrl = await application.getUrl();
});

afterAll(async () => {
  await application?.close();
  await sqsClient.send(new DeleteQueueCommand({ QueueUrl: commandQueueUrl }));
  sqsClient.destroy();
  await databaseContext?.close();
});

describe('HTTP and SQS idempotency convergence', () => {
  test('persists one equivalent outcome when the same command crosses both transports', async () => {
    const playerId = randomUUID();
    const walletResponse = await post('/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(walletResponse.response.status).toBe(201);
    const walletId = String(walletResponse.body.id);
    const messageId = randomUUID();
    const command = {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: `provider-a:${messageId}`,
      playerId,
      walletId,
      roundId: 'round-cross-transport',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    } as const;
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: '2026-09-04T12:00:00.000Z',
      data: command,
    } as const;
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: commandQueueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: walletId,
        MessageDeduplicationId: messageId,
      }),
    );
    const received = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: commandQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        AttributeNames: ['All'],
      }),
    );
    const message = received.Messages?.[0];
    if (message === undefined) {
      throw new Error('LocalStack did not deliver the command message');
    }

    const context = getDatabaseContext();
    const environment = createTestEnvironment({
      DATABASE_NAME: context.databaseName,
      SQS_COMMAND_QUEUE_URL: commandQueueUrl,
    });
    const wageringRunner = new MikroOrmTransactionRunner(context.orm, (entityManager) =>
      createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
    );
    const consumer = new WagerCommandConsumer({
      consumerName: 'wager-command-consumer',
      transactionRunner: wageringRunner,
      processWagerTransaction: new ProcessWagerTransactionUseCase(wageringRunner),
      sqsClient,
      queueConfiguration: createSqsQueueConfiguration(environment.configuration),
    });

    const sqsResult = await consumer.processMessage(message);
    const httpResult = await post(
      '/wagering/transactions',
      {
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        playerId: command.playerId,
        walletId: command.walletId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
      },
      { 'idempotency-key': command.idempotencyKey, 'x-correlation-id': messageId },
    );

    expect(httpResult.response.status).toBe(201);
    expect(httpResult.body).toEqual({
      transactionId: sqsResult.outcome?.transactionId,
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    expect(sqsResult).toMatchObject({
      action: 'ACK',
      outcome: {
        status: 'PROCESSED',
        idempotentReplay: false,
      },
    });
    if (sqsResult.outcome === undefined || !('balance' in sqsResult.outcome)) {
      throw new Error('SQS result did not contain a financial outcome');
    }
    expect(sqsResult.outcome.balance.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });

    const queueAttributes = await sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: commandQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    expect(queueAttributes.Attributes).toMatchObject({
      ApproximateNumberOfMessages: '0',
      ApproximateNumberOfMessagesNotVisible: '0',
    });

    const rows = await context.orm.em.getConnection().execute<Record<string, string>[]>(
      `select
         (select count(*)::text from inbox_messages where consumer_name = ? and message_id = ?) as inbox_messages,
         (select count(*)::text from wager_transactions where provider_id = ? and idempotency_key = ?) as transactions,
         (select count(*)::text from wallet_ledger_entries entry
           join wager_transactions transaction on transaction.id = entry.transaction_id
          where transaction.provider_id = ? and transaction.idempotency_key = ?) as ledger_entries,
         (select count(*)::text from accounting_journals journal
           join wager_transactions transaction on transaction.id = journal.transaction_id
          where transaction.provider_id = ? and transaction.idempotency_key = ?) as journals,
         (select count(*)::text from outbox_messages
           where payload -> 'data' ->> 'transactionId' =
             (select id::text from wager_transactions where provider_id = ? and idempotency_key = ?)) as outbox_messages`,
      [
        'wager-command-consumer',
        messageId,
        command.providerId,
        command.idempotencyKey,
        command.providerId,
        command.idempotencyKey,
        command.providerId,
        command.idempotencyKey,
        command.providerId,
        command.idempotencyKey,
      ],
    );
    expect(rows[0]).toEqual({
      inbox_messages: '1',
      transactions: '1',
      ledger_entries: '1',
      journals: '1',
      outbox_messages: '2',
    });
  });

  test('returns the same insufficient-funds rejection through SQS and HTTP replay', async () => {
    const wallet = await createWallet('20.00');
    const command = createCommand(wallet, { money: { amount: '25.00', currency: 'BRL' } });

    const sqs = await processThroughSqs(command);
    const http = await post('/wagering/transactions', toHttpBody(command), {
      'idempotency-key': command.idempotencyKey,
      'x-correlation-id': sqs.messageId,
    });

    expect(sqs.result).toMatchObject({
      action: 'ACK',
      outcome: {
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        idempotentReplay: false,
      },
    });
    if (sqs.result.outcome === undefined || !('balance' in sqs.result.outcome)) {
      throw new Error('SQS rejection did not contain its observed balance');
    }
    expect(sqs.result.outcome.balance.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(http.response.status).toBe(422);
    expect(http.body).toEqual({
      transactionId: sqs.result.outcome.transactionId,
      status: 'REJECTED',
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: true,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(await persistedCommandCounts(command, sqs.messageId)).toEqual({
      inbox_messages: '1',
      transactions: '1',
      ledger_entries: '0',
      journals: '0',
      outbox_messages: '1',
    });
  });

  test('returns the same pending-reference acceptance through SQS and HTTP replay', async () => {
    const wallet = await createWallet();
    const command = createCommand(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: randomUUID(),
    });

    const sqs = await processThroughSqs(command);
    const http = await post('/wagering/transactions', toHttpBody(command), {
      'idempotency-key': command.idempotencyKey,
      'x-correlation-id': sqs.messageId,
    });

    expect(sqs.result).toMatchObject({
      action: 'ACK',
      outcome: { status: 'PENDING_REFERENCE', idempotentReplay: false },
    });
    if (sqs.result.outcome === undefined || !('balance' in sqs.result.outcome)) {
      throw new Error('SQS pending result did not contain its observed balance');
    }
    expect(sqs.result.outcome.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(http.response.status).toBe(202);
    expect(http.body).toEqual({
      transactionId: sqs.result.outcome.transactionId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    expect(await persistedCommandCounts(command, sqs.messageId)).toEqual({
      inbox_messages: '1',
      transactions: '1',
      ledger_entries: '0',
      journals: '0',
      outbox_messages: '1',
    });
  });

  test('acknowledges the same idempotency conflict classification produced by HTTP', async () => {
    const wallet = await createWallet();
    const original = createCommand(wallet);
    const originalHttp = await post('/wagering/transactions', toHttpBody(original), {
      'idempotency-key': original.idempotencyKey,
    });
    expect(originalHttp.response.status).toBe(201);
    expect(originalHttp.body.transactionId).toBeString();
    const originalTransactionId = String(originalHttp.body.transactionId);
    const conflicting = { ...original, money: { amount: '30.00', currency: 'BRL' } };

    const sqs = await processThroughSqs(conflicting);
    const http = await post('/wagering/transactions', toHttpBody(conflicting), {
      'idempotency-key': conflicting.idempotencyKey,
      'x-correlation-id': sqs.messageId,
    });

    expect(sqs.result).toEqual({
      action: 'ACK',
      outcome: {
        transactionId: originalTransactionId,
        status: 'CONFLICT',
        failureCode: 'IDEMPOTENCY_CONFLICT',
        idempotentReplay: false,
      },
    });
    expect(http.response.status).toBe(409);
    expect(http.body).toMatchObject({ failureCode: 'IDEMPOTENCY_CONFLICT' });
    expect(await persistedCommandCounts(conflicting, sqs.messageId)).toEqual({
      inbox_messages: '1',
      transactions: '1',
      ledger_entries: '1',
      journals: '1',
      outbox_messages: '2',
    });
  });
});
