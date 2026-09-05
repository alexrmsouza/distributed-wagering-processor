import { randomUUID } from 'node:crypto';

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

async function startConsumer(
  mode: 'crash-after-commit' | 'normal',
): Promise<RunningConsumerProcess> {
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

async function stopProcess(processHandle: RunningConsumerProcess): Promise<void> {
  if (processHandle.handle.exitCode === null) {
    expect(await processHandle.stop()).toBe(0);
  } else {
    await processHandle.handle.exited;
  }
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

function createBetEnvelope(playerId: string, walletId: string): WagerCommandEnvelope {
  return Object.freeze({
    messageId: `message-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: `transaction-${randomUUID()}`,
      idempotencyKey: `idempotency-${randomUUID()}`,
      playerId,
      walletId,
      roundId: 'round-commit-ack-crash',
      gameId: 'fortune-chimp',
      kind: 'BET' as const,
      money: { amount: '25.00', currency: 'BRL' },
    },
  });
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('sqs_commit_ack_crash');
  await databaseContext.orm.migrator.up();
  commandQueue = await createIsolatedCommandQueue(sqsClient, 'commit-ack-crash');
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

describe('SQS commit-before-ack crash recovery', () => {
  test('redelivers across three processes without duplicating financial or event effects', async () => {
    const wallet = await createFundedWallet();
    const envelope = createBetEnvelope(wallet.playerId, wallet.walletId);
    const crashingConsumer = await startConsumer('crash-after-commit');

    await sendWagerCommand(sqsClient, getCommandQueue().commandQueueUrl, envelope);
    await crashingConsumer.waitForMarker('COMMITTED_BEFORE_ACK');
    expect(await crashingConsumer.handle.exited).toBe(86);
    processes.delete(crashingConsumer);

    const recoveryConsumers = await Promise.all(
      Array.from({ length: 3 }, () => startConsumer('normal')),
    );
    await Promise.race(
      recoveryConsumers.map((consumer) =>
        consumer.waitForMarker(
          'RECEIPT_TRANSITION',
          (marker) => marker.messageId === envelope.messageId && marker.state === 'acknowledged',
          30_000,
        ),
      ),
    );

    const rows = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<
        {
          credit_minor: string;
          debit_minor: string;
          inbox_messages: string;
          journals: string;
          ledger_entries: string;
          postings: string;
          processed_inbox_messages: string;
          transactions: string;
          wallet_balance_minor: string;
        }[]
      >(
        `select
           count(distinct transaction.id)::text as transactions,
           count(distinct entry.id)::text as ledger_entries,
           count(distinct journal.id)::text as journals,
           count(distinct posting.id)::text as postings,
           coalesce(sum(posting.amount_minor) filter (where posting.direction = 'DEBIT'), 0)::text
             as debit_minor,
           coalesce(sum(posting.amount_minor) filter (where posting.direction = 'CREDIT'), 0)::text
             as credit_minor,
           count(distinct inbox.message_id)::text as inbox_messages,
           count(distinct inbox.message_id) filter (where inbox.processed_at is not null)::text
             as processed_inbox_messages,
           max(wallet.balance_minor)::text as wallet_balance_minor
         from inbox_messages inbox
         join wager_transactions transaction on transaction.id = inbox.transaction_id
         join wallets wallet on wallet.id = transaction.wallet_id
         left join wallet_ledger_entries entry on entry.transaction_id = transaction.id
         left join accounting_journals journal on journal.transaction_id = transaction.id
         left join accounting_postings posting on posting.journal_id = journal.id
        where inbox.consumer_name = ? and inbox.message_id = ?`,
        [CONSUMER_NAME, envelope.messageId],
      );
    expect(rows).toEqual([
      {
        transactions: '1',
        ledger_entries: '1',
        journals: '1',
        postings: '2',
        debit_minor: '2500',
        credit_minor: '2500',
        inbox_messages: '1',
        processed_inbox_messages: '1',
        wallet_balance_minor: '7500',
      },
    ]);

    const events = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ event_type: string; occurrences: string }[]>(
        `select outbox.event_type, count(*)::text as occurrences
           from outbox_messages outbox
           join inbox_messages inbox
             on inbox.transaction_id = (outbox.payload -> 'data' ->> 'transactionId')::uuid
          where inbox.consumer_name = ? and inbox.message_id = ?
          group by outbox.event_type
          order by outbox.event_type`,
        [CONSUMER_NAME, envelope.messageId],
      );
    expect(events).toEqual([
      { event_type: 'WagerTransactionProcessed', occurrences: '1' },
      { event_type: 'WalletBalanceChanged', occurrences: '1' },
    ]);

    await Promise.all(recoveryConsumers.map(stopProcess));
  });
});
