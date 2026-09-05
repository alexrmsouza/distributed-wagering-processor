import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/core';
import { expect, setDefaultTimeout, test } from 'bun:test';

import type { IntegrationEventEnvelope } from '../../src/messaging/application/integration-event.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { ReconcileWalletUseCase } from '../../src/wallet/application/reconcile-wallet.use-case.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import {
  createHttpDispatcher,
  createLoadPlan,
  createSqsDispatcher,
  executeLoadPlan,
  writeLoadExecutionArtifact,
  type LoadOperation,
  type LoadWalletTarget,
} from '../../scripts/load.js';
import { formatLoadReport, type LoadReportInput } from '../../scripts/report-load.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import { EventSinkConsumer } from '../support/event-sink.consumer.js';
import {
  createIsolatedCommandQueue,
  createSqsClient,
  type IsolatedCommandQueue,
} from '../support/sqs-consumer-process.js';
import { startThreeInstanceHarness } from '../support/three-instance-harness.js';
import { createTestEnvironment } from '../support/test-environment.js';

setDefaultTimeout(240_000);

interface IsolatedEventQueue {
  readonly queueUrl: string;
  delete(): Promise<void>;
}

interface FinancialSnapshot {
  readonly providerTransactions: number;
  readonly processedReversals: number;
  readonly unresolvedReferences: number;
  readonly duplicateTransactions: number;
  readonly ledgerEntries: number;
  readonly journals: number;
  readonly postings: number;
  readonly balancedJournals: number;
  readonly publishedOutbox: number;
  readonly pendingOutbox: number;
  readonly outboxLagMs: readonly number[];
}

interface WalletIdentity extends LoadWalletTarget {
  readonly initialBalanceMinor: bigint;
}

const DEFAULT_OPERATION_COUNT = 300;
const DEFAULT_WARMUP_MS = 15_000;
const POLL_INTERVAL_MS = 250;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

async function createEventQueue(client: SQSClient, runId: string): Promise<IsolatedEventQueue> {
  const queueName = `load-events-${runId.slice(-16)}.fifo`;
  await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        ReceiveMessageWaitTimeSeconds: '1',
      },
    }),
  );
  const queueUrl = (await client.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl;
  if (queueUrl === undefined) {
    throw new Error('Load event queue URL is unavailable');
  }
  return Object.freeze({
    queueUrl,
    delete: async () => {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    },
  });
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Evaluator setup request failed with HTTP ${String(response.status)}`);
  }
  return asRecord((await response.json()) as unknown);
}

async function createWallet(baseUrl: string, initialBalance: string): Promise<WalletIdentity> {
  const playerId = randomUUID();
  const response = await postJson(baseUrl, '/wallets', {
    playerId,
    initialBalance: { amount: initialBalance, currency: 'BRL' },
  });
  if (typeof response.id !== 'string') {
    throw new Error('Evaluator wallet identity is unavailable');
  }
  return Object.freeze({
    walletId: response.id,
    playerId,
    initialBalanceMinor: BigInt(initialBalance.replace('.', '')),
  });
}

function uniqueBusinessTransactionCount(operations: readonly LoadOperation[]): number {
  return new Set(
    operations.map(
      ({ command }) =>
        `${command.providerId}:${command.externalTransactionId}:${command.idempotencyKey}`,
    ),
  ).size;
}

async function pollUntil(
  description: string,
  timeoutMs: number,
  condition: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function readFinancialSnapshot(
  database: DatabaseTestContext,
  providerId: string,
  duplicateIdempotencyKey: string,
): Promise<FinancialSnapshot> {
  const rows = await database.orm.em.getConnection().execute<
    {
      balanced_journals: string;
      duplicate_transactions: string;
      journals: string;
      ledger_entries: string;
      pending_outbox: string;
      processed_reversals: string;
      provider_transactions: string;
      published_outbox: string;
      postings: string;
      unresolved_references: string;
    }[]
  >(
    `select
       (select count(*)::text from wager_transactions where provider_id = ?) as provider_transactions,
       (select count(*)::text from wager_transactions
         where provider_id = ? and kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'
           and reference_transaction_id is not null) as processed_reversals,
       (select count(*)::text from wager_transactions
         where provider_id = ? and status = 'PENDING_REFERENCE') as unresolved_references,
       (select count(*)::text from wager_transactions
         where provider_id = ? and idempotency_key = ?) as duplicate_transactions,
       (select count(*)::text from wallet_ledger_entries ledger
         join wager_transactions transaction on transaction.id = ledger.transaction_id
        where transaction.provider_id = ?) as ledger_entries,
       (select count(*)::text from accounting_journals journal
         join wager_transactions transaction on transaction.id = journal.transaction_id
        where transaction.provider_id = ?) as journals,
       (select count(*)::text from accounting_postings posting
         join accounting_journals journal on journal.id = posting.journal_id
         join wager_transactions transaction on transaction.id = journal.transaction_id
        where transaction.provider_id = ?) as postings,
       (select count(*)::text from (
          select journal.id
            from accounting_journals journal
            join wager_transactions transaction on transaction.id = journal.transaction_id
            join accounting_postings posting on posting.journal_id = journal.id
           where transaction.provider_id = ?
           group by journal.id
          having sum(case when posting.direction = 'DEBIT' then posting.amount_minor else 0 end) =
                 sum(case when posting.direction = 'CREDIT' then posting.amount_minor else 0 end)
       ) balanced) as balanced_journals,
       (select count(*)::text from outbox_messages where published_at is not null) as published_outbox,
       (select count(*)::text from outbox_messages where published_at is null) as pending_outbox`,
    [
      providerId,
      providerId,
      providerId,
      providerId,
      duplicateIdempotencyKey,
      providerId,
      providerId,
      providerId,
      providerId,
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('Load financial snapshot is unavailable');
  }
  const lagRows = await database.orm.em.getConnection().execute<{ lag_ms: string }[]>(
    `select greatest(0, extract(epoch from (published_at - occurred_at)) * 1000)::text as lag_ms
       from outbox_messages
      where published_at is not null
      order by occurred_at, id`,
  );
  return Object.freeze({
    providerTransactions: Number(row.provider_transactions),
    processedReversals: Number(row.processed_reversals),
    unresolvedReferences: Number(row.unresolved_references),
    duplicateTransactions: Number(row.duplicate_transactions),
    ledgerEntries: Number(row.ledger_entries),
    journals: Number(row.journals),
    postings: Number(row.postings),
    balancedJournals: Number(row.balanced_journals),
    publishedOutbox: Number(row.published_outbox),
    pendingOutbox: Number(row.pending_outbox),
    outboxLagMs: Object.freeze(lagRows.map(({ lag_ms }) => Number(lag_ms))),
  });
}

function parseMetricValue(text: string, metric: string): number {
  return text
    .split('\n')
    .filter((line) => line.startsWith(metric) && !line.startsWith('#'))
    .reduce((total, line) => total + Number(line.trim().split(/\s+/).at(-1) ?? '0'), 0);
}

async function aggregateLockMetrics(baseUrls: readonly string[]): Promise<{
  readonly conflicts: number;
  readonly waits: number;
  readonly waitDurationMs: readonly number[];
}> {
  const payloads = await Promise.all(
    baseUrls.map(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        throw new Error('Unable to read load metrics');
      }
      return response.text();
    }),
  );
  const waits = payloads.reduce(
    (total, payload) => total + parseMetricValue(payload, 'wallet_lock_wait_seconds_count'),
    0,
  );
  const waitSeconds = payloads.reduce(
    (total, payload) => total + parseMetricValue(payload, 'wallet_lock_wait_seconds_sum'),
    0,
  );
  const averageWaitMs = waits === 0 ? 0 : (waitSeconds * 1_000) / waits;
  return Object.freeze({
    conflicts: payloads.reduce(
      (total, payload) => total + parseMetricValue(payload, 'wallet_lock_conflicts_total'),
      0,
    ),
    waits,
    waitDurationMs: Object.freeze(Array.from({ length: waits }, () => averageWaitMs)),
  });
}

function parseEnvelope(message: Message): IntegrationEventEnvelope {
  if (message.Body === undefined) {
    throw new Error('Published event body is unavailable');
  }
  const value = asRecord(JSON.parse(message.Body) as unknown);
  if (
    typeof value.eventId !== 'string' ||
    typeof value.eventType !== 'string' ||
    typeof value.aggregateId !== 'string' ||
    typeof value.correlationId !== 'string' ||
    typeof value.occurredAt !== 'string' ||
    typeof value.version !== 'number' ||
    typeof value.data !== 'object' ||
    value.data === null
  ) {
    throw new Error('Published event envelope is invalid');
  }
  return value as unknown as IntegrationEventEnvelope;
}

async function drainEventQueue(
  database: DatabaseTestContext,
  client: SQSClient,
  queueUrl: string,
  consumerName: string,
  expectedEvents: number,
): Promise<{ readonly duplicatesSafe: boolean; readonly effects: number }> {
  await database.orm.em.getConnection().execute(`
    create table integration_event_sink_effects (
      consumer_name varchar(128) not null,
      event_id uuid not null,
      event_type varchar(128) not null,
      payload jsonb not null,
      primary key (consumer_name, event_id)
    )
  `);
  const sink = new EventSinkConsumer({
    orm: database.orm,
    consumerName,
    onEvent: async (event: IntegrationEventEnvelope, entityManager: EntityManager) => {
      await entityManager.getConnection().execute(
        `insert into integration_event_sink_effects
           (consumer_name, event_id, event_type, payload)
         values (?, ?::uuid, ?, ?::jsonb)`,
        [consumerName, event.eventId, event.eventType, JSON.stringify(event)],
        'run',
        entityManager.getTransactionContext(),
      );
    },
  });
  let duplicatesSafe = false;
  await pollUntil('published integration-event drain', 60_000, async () => {
    const response = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    for (const message of response.Messages ?? []) {
      const receiptHandle = message.ReceiptHandle;
      if (receiptHandle === undefined) {
        throw new Error('Published event receipt is unavailable');
      }
      const envelope = parseEnvelope(message);
      await sink.processEnvelope(envelope);
      if (!duplicatesSafe) {
        const replay = await sink.processEnvelope(envelope);
        duplicatesSafe = replay.status === 'DUPLICATE';
      }
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
      );
    }
    const counts = await database.orm.em
      .getConnection()
      .execute<{ count: string }[]>(
        'select count(*)::text as count from integration_event_sink_effects where consumer_name = ?',
        [consumerName],
      );
    return Number(counts[0]?.count ?? '0') >= expectedEvents;
  });
  const counts = await database.orm.em
    .getConnection()
    .execute<{ count: string }[]>(
      'select count(*)::text as count from integration_event_sink_effects where consumer_name = ?',
      [consumerName],
    );
  return Object.freeze({ duplicatesSafe, effects: Number(counts[0]?.count ?? '0') });
}

function expectedWalletBalance(
  wallet: WalletIdentity,
  operations: readonly LoadOperation[],
): bigint {
  const unique = new Map<string, LoadOperation>();
  for (const operation of operations) {
    unique.set(`${operation.command.providerId}:${operation.command.idempotencyKey}`, operation);
  }
  return [...unique.values()]
    .filter(({ command }) => command.walletId === wallet.walletId)
    .reduce((balance, { command }) => {
      if (command.kind === 'BET' || command.kind === 'ROLLBACK') {
        return balance - 100n;
      }
      if (command.kind === 'WIN' || command.kind === 'REFUND') {
        return balance + 100n;
      }
      return balance;
    }, wallet.initialBalanceMinor);
}

test('proves the seeded distributed wagering workload across three processes', async () => {
  const seed = process.env.LOAD_SEED ?? 'distributed-load-evaluator-seed';
  const runId = `load-${String(process.pid)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const operationCount = Number(process.env.LOAD_OPERATION_COUNT ?? DEFAULT_OPERATION_COUNT);
  if (!Number.isInteger(operationCount) || operationCount < 250) {
    throw new Error('LOAD_OPERATION_COUNT must be at least 250 to prove fifty duplicates');
  }
  const baseEnvironment = createTestEnvironment();
  const sqsClient = createSqsClient(baseEnvironment.variables);
  let database: DatabaseTestContext | undefined;
  let commandQueue: IsolatedCommandQueue | undefined;
  let eventQueue: IsolatedEventQueue | undefined;
  let harness: Awaited<ReturnType<typeof startThreeInstanceHarness>> | undefined;

  try {
    database = await createDatabaseTestContext('distributed_load');
    const activeDatabase = database;
    await database.orm.migrator.up();
    commandQueue = await createIsolatedCommandQueue(sqsClient, `load-${runId.slice(-12)}`);
    eventQueue = await createEventQueue(sqsClient, runId);
    const environment = createTestEnvironment({
      DATABASE_NAME: database.databaseName,
      SQS_COMMAND_QUEUE_URL: commandQueue.commandQueueUrl,
      SQS_COMMAND_DLQ_URL: commandQueue.deadLetterQueueUrl,
      SQS_EVENT_QUEUE_URL: eventQueue.queueUrl,
      SQS_CONSUMER_ENABLED: 'true',
      OUTBOX_PUBLISHER_ENABLED: 'true',
    });
    harness = await startThreeInstanceHarness({
      environment: {
        ...environment.variables,
        OUTBOX_PUBLISHER_POLL_INTERVAL_MS: '10',
      },
      runId,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000,
    });
    const baseUrls = harness.instances.map(({ baseUrl }) => baseUrl);
    const [firstBaseUrl, secondBaseUrl, thirdBaseUrl] = baseUrls;
    if (firstBaseUrl === undefined || secondBaseUrl === undefined || thirdBaseUrl === undefined) {
      throw new Error('Three service base URLs are required');
    }
    const hotWallet = await createWallet(firstBaseUrl, '500.00');
    const independentWallets = await Promise.all([
      createWallet(secondBaseUrl, '100.00'),
      createWallet(thirdBaseUrl, '100.00'),
      createWallet(firstBaseUrl, '100.00'),
    ]);
    const plan = createLoadPlan({
      seed,
      runId,
      operationCount,
      occurredAt: new Date().toISOString(),
      hotWallet,
      independentWallets,
    });
    expect(plan.profile.exactDuplicate).toBeGreaterThanOrEqual(50);
    await Bun.sleep(Number(process.env.LOAD_WARMUP_MS ?? DEFAULT_WARMUP_MS));
    const execution = await executeLoadPlan(
      plan,
      {
        http: createHttpDispatcher(baseUrls),
        sqs: createSqsDispatcher(sqsClient, commandQueue.commandQueueUrl),
      },
      {
        concurrency: Number(process.env.LOAD_CONCURRENCY ?? '24'),
        operationTimeoutMs: 15_000,
        runTimeoutMs: 120_000,
        warmupDurationMs: Number(process.env.LOAD_WARMUP_MS ?? DEFAULT_WARMUP_MS),
        processCount: 3,
        dockerMode: 'wsl',
      },
    );
    expect(execution.outcomes.transientError).toBe(0);
    expect(execution.outcomes.unexpectedError).toBe(0);
    const providerId = plan.operations[0]?.command.providerId;
    const duplicateOperation = plan.operations.find(
      ({ scenario }) => scenario === 'exact_duplicate',
    );
    if (providerId === undefined || duplicateOperation === undefined) {
      throw new Error('Load plan business identities are unavailable');
    }
    const expectedTransactions = uniqueBusinessTransactionCount(plan.operations);
    const expectedReversals = plan.profile.outOfOrderReference / 2;
    await pollUntil('all business transactions and pending references', 90_000, async () => {
      const snapshot = await readFinancialSnapshot(
        activeDatabase,
        providerId,
        duplicateOperation.command.idempotencyKey,
      );
      return (
        snapshot.providerTransactions === expectedTransactions &&
        snapshot.processedReversals === expectedReversals &&
        snapshot.unresolvedReferences === 0
      );
    });
    await pollUntil('eventual Outbox publication', 60_000, async () => {
      const snapshot = await readFinancialSnapshot(
        activeDatabase,
        providerId,
        duplicateOperation.command.idempotencyKey,
      );
      return snapshot.pendingOutbox === 0;
    });
    const snapshot = await readFinancialSnapshot(
      database,
      providerId,
      duplicateOperation.command.idempotencyKey,
    );
    const wallets = [hotWallet, ...independentWallets];
    const runner = new MikroOrmTransactionRunner(database.orm, createWalletTransactionContext);
    const reconcile = new ReconcileWalletUseCase(runner);
    const reconciliations = await Promise.all(
      wallets.map(({ walletId }) => reconcile.execute(walletId)),
    );
    const balances = await database.orm.em
      .getConnection()
      .execute<{ balance_minor: string; id: string }[]>(
        'select id::text, balance_minor::text from wallets order by id',
      );
    const actualBalanceByWallet = new Map(
      balances.map(({ id, balance_minor }) => [id, BigInt(balance_minor)]),
    );
    const balancesCorrect = wallets.every(
      (wallet) =>
        actualBalanceByWallet.get(wallet.walletId) ===
        expectedWalletBalance(wallet, plan.operations),
    );
    const downstream = await drainEventQueue(
      database,
      sqsClient,
      eventQueue.queueUrl,
      `load-event-sink-${runId}`,
      snapshot.publishedOutbox,
    );
    const lockMetrics = await aggregateLockMetrics(baseUrls);
    const financialInvariants =
      balancesCorrect &&
      reconciliations.every(({ consistent }) => consistent) &&
      snapshot.ledgerEntries === snapshot.journals &&
      snapshot.postings === snapshot.journals * 2 &&
      snapshot.balancedJournals === snapshot.journals;
    const reportInput: LoadReportInput = {
      schemaVersion: 1,
      metadata: {
        name: 'distributed-wagering-load',
        seed,
        generatedAt: execution.metadata.generatedAt,
        measurementDurationMs: execution.metadata.measurementDurationMs,
        warmupDurationMs: execution.metadata.warmupDurationMs,
        concurrency: execution.metadata.concurrency,
        processCount: 3,
      },
      environment: {
        platform: process.platform as 'darwin' | 'linux' | 'win32',
        architecture: process.arch as 'arm64' | 'x64',
        bunVersion: Bun.version,
        dockerMode: 'WSL2',
      },
      traffic: {
        attempted: execution.traffic.attempted,
        completed: execution.traffic.completed,
        http: execution.traffic.http,
        sqs: execution.traffic.sqs,
        terminalLatencyMs: [...execution.traffic.terminalLatencyMs],
      },
      outcomes: {
        processed: execution.outcomes.processed,
        rejected: execution.outcomes.rejected,
        pendingReference: execution.outcomes.pendingReference,
        idempotentReplay: execution.outcomes.idempotentReplay,
        conflict: execution.outcomes.conflict,
        failed: execution.outcomes.failed,
        sqsAccepted: execution.outcomes.sqsAccepted,
        transientError: execution.outcomes.transientError,
      },
      duplicates: {
        deliveries: plan.profile.exactDuplicate,
        suppressed: plan.profile.exactDuplicate - snapshot.duplicateTransactions,
        logicalEffects: snapshot.duplicateTransactions,
      },
      locks: { ...lockMetrics, waitDurationMs: [...lockMetrics.waitDurationMs] },
      outbox: {
        published: snapshot.publishedOutbox,
        pending: snapshot.pendingOutbox,
        lagMs: [...snapshot.outboxLagMs],
      },
      reconciliation: {
        walletsChecked: reconciliations.length,
        consistentWallets: reconciliations.filter(({ consistent }) => consistent).length,
        divergentWallets: reconciliations.filter(({ consistent }) => !consistent).length,
      },
      correctness: {
        checks: [
          { name: 'HOT_WALLET_SERIALIZATION', passed: balancesCorrect },
          {
            name: 'INDEPENDENT_WALLET_PROGRESS',
            passed: independentWallets.every(({ walletId }) => actualBalanceByWallet.has(walletId)),
          },
          { name: 'HTTP_SQS_CONVERGENCE', passed: snapshot.duplicateTransactions === 1 },
          { name: 'DUPLICATE_SUPPRESSION', passed: snapshot.duplicateTransactions === 1 },
          {
            name: 'PENDING_REFERENCE_RESOLUTION',
            passed:
              snapshot.processedReversals === expectedReversals &&
              snapshot.unresolvedReferences === 0,
          },
          { name: 'FINANCIAL_INVARIANTS', passed: financialInvariants },
          {
            name: 'EVENTUAL_OUTBOX_PUBLICATION',
            passed:
              snapshot.pendingOutbox === 0 &&
              downstream.duplicatesSafe &&
              downstream.effects === snapshot.publishedOutbox,
          },
        ],
      },
    };
    const formatted = formatLoadReport(reportInput);
    const artifactPaths = await writeLoadExecutionArtifact(execution);
    await Promise.all([
      Bun.write(artifactPaths.reportJson, formatted.json),
      Bun.write(artifactPaths.reportMarkdown, formatted.markdown),
    ]);

    expect(formatted.report.summary.correctness).toBe('PASSED');
    expect(snapshot.duplicateTransactions).toBe(1);
    expect(snapshot.processedReversals).toBe(expectedReversals);
    expect(snapshot.pendingOutbox).toBe(0);
    expect(reconciliations.every(({ consistent }) => consistent)).toBeTrue();
    expect(harness.instances).toHaveLength(3);
  } catch (error: unknown) {
    if (database !== undefined) {
      const outboxDiagnostics = await database.orm.em.getConnection().execute<
        {
          attempts: string;
          event_type: string;
          leased: boolean;
          messages: string;
          published: boolean;
        }[]
      >(
        `select event_type,
                published_at is not null as published,
                lease_token is not null as leased,
                max(attempts)::text as attempts,
                count(*)::text as messages
           from outbox_messages
          group by event_type, published_at is not null, lease_token is not null
          order by event_type, published, leased`,
      );
      console.error(
        JSON.stringify({
          event: 'LOAD_TEST_FAILURE',
          outbox: outboxDiagnostics,
          services: harness?.diagnostics().map(({ state, exitCode, events }) => ({
            state,
            exitCode,
            events,
          })),
        }),
      );
    }
    throw error;
  } finally {
    await harness?.stop();
    await eventQueue?.delete();
    await commandQueue?.delete();
    sqsClient.destroy();
    await database?.close();
  }
});
