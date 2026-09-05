import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import {
  parseEnvironment,
  type EnvironmentSource,
} from '../../src/bootstrap/configuration/environment.schema.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import type {
  FailpointName,
  FailpointPort,
} from '../../src/shared/infrastructure/failpoints/failpoint.port.js';
import { NOOP_WALLET_LOCK_METRICS } from '../../src/wallet/application/ports/wallet-lock-metrics.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { createWageringTransactionContext } from '../../src/wagering/infrastructure/persistence/wagering-transaction-context.js';

const PROCESS_CONFIGURATION_VARIABLE = 'SQS_CONSUMER_PROCESS_CONFIGURATION';

export type ConsumerProcessMode =
  'normal' | 'crash-after-commit' | 'pause-after-commit' | 'pause-before-commit';

export interface ConsumerProcessConfiguration {
  readonly commandQueueUrl: string;
  readonly consumerName: string;
  readonly environment: EnvironmentSource;
  readonly gracePeriodMs: number;
  readonly mode: ConsumerProcessMode;
}

interface ProcessMarker {
  readonly event: string;
  readonly messageId?: string;
  readonly state?: string;
}

export interface WagerCommandEnvelope {
  readonly messageId: string;
  readonly type: 'WagerTransactionRequested';
  readonly occurredAt: string;
  readonly data: {
    readonly providerId: string;
    readonly externalTransactionId: string;
    readonly idempotencyKey: string;
    readonly playerId: string;
    readonly walletId: string;
    readonly roundId: string;
    readonly gameId: string;
    readonly kind: 'BET' | 'LOSS' | 'REFUND' | 'ROLLBACK' | 'WIN';
    readonly money: { readonly amount: string; readonly currency: string };
    readonly referenceExternalTransactionId?: string;
  };
}

export interface IsolatedCommandQueue {
  readonly commandQueueUrl: string;
  readonly deadLetterQueueUrl: string;
  delete(): Promise<void>;
}

interface MarkerWaiter {
  readonly event: string;
  readonly predicate: (marker: ProcessMarker) => boolean;
  readonly reject: (error: Error) => void;
  readonly resolve: (marker: ProcessMarker) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export interface RunningConsumerProcess {
  readonly handle: ReturnType<typeof Bun.spawn>;
  readonly markers: readonly ProcessMarker[];
  readonly standardError: () => string;
  stop(): Promise<number>;
  waitForMarker(
    event: string,
    predicate?: (marker: ProcessMarker) => boolean,
    timeoutMs?: number,
  ): Promise<ProcessMarker>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function parseProcessMarker(line: string): ProcessMarker | null {
  try {
    const value = asRecord(JSON.parse(line) as unknown);
    if (typeof value.event !== 'string') {
      return null;
    }
    return Object.freeze({
      event: value.event,
      ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
      ...(typeof value.state === 'string' ? { state: value.state } : {}),
    });
  } catch {
    return null;
  }
}

function writeMarker(marker: ProcessMarker): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(marker)}\n`, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

class ProcessFailpoints implements FailpointPort {
  #rejectGate: ((error: Error) => void) | undefined;
  #resolveGate: (() => void) | undefined;

  public constructor(private readonly mode: ConsumerProcessMode) {}

  public async trigger(name: FailpointName): Promise<void> {
    if (!this.matches(name)) {
      return;
    }

    const event =
      name === 'after_financial_commit_before_sqs_ack'
        ? 'COMMITTED_BEFORE_ACK'
        : 'BEFORE_FINANCIAL_COMMIT';
    await writeMarker({ event });

    if (this.mode === 'crash-after-commit') {
      process.exit(86);
    }

    await new Promise<void>((resolve, reject) => {
      this.#resolveGate = resolve;
      this.#rejectGate = reject;
    });
  }

  public releaseForShutdown(): void {
    if (this.mode === 'pause-before-commit') {
      this.#rejectGate?.(new Error('Consumer shutdown interrupted uncommitted work'));
    } else {
      this.#resolveGate?.();
    }
    this.#rejectGate = undefined;
    this.#resolveGate = undefined;
  }

  private matches(name: FailpointName): boolean {
    if (this.mode === 'pause-before-commit') {
      return name === 'before_financial_commit';
    }
    return (
      (this.mode === 'crash-after-commit' || this.mode === 'pause-after-commit') &&
      name === 'after_financial_commit_before_sqs_ack'
    );
  }
}

function parseProcessConfiguration(): ConsumerProcessConfiguration {
  const raw = process.env[PROCESS_CONFIGURATION_VARIABLE];
  if (raw === undefined) {
    throw new Error(`${PROCESS_CONFIGURATION_VARIABLE} is required`);
  }
  const value = asRecord(JSON.parse(raw) as unknown);
  const environment = asRecord(value.environment);
  if (
    typeof value.commandQueueUrl !== 'string' ||
    typeof value.consumerName !== 'string' ||
    typeof value.gracePeriodMs !== 'number' ||
    typeof value.mode !== 'string'
  ) {
    throw new TypeError('Invalid SQS consumer process configuration');
  }
  if (
    value.mode !== 'normal' &&
    value.mode !== 'crash-after-commit' &&
    value.mode !== 'pause-after-commit' &&
    value.mode !== 'pause-before-commit'
  ) {
    throw new TypeError('Invalid SQS consumer process mode');
  }
  return Object.freeze({
    commandQueueUrl: value.commandQueueUrl,
    consumerName: value.consumerName,
    environment: Object.freeze(
      Object.fromEntries(
        Object.entries(environment).map(([key, entry]) => [
          key,
          typeof entry === 'string' ? entry : undefined,
        ]),
      ),
    ),
    gracePeriodMs: value.gracePeriodMs,
    mode: value.mode,
  });
}

export function createSqsClient(environmentSource: EnvironmentSource): SQSClient {
  const environment = parseEnvironment(environmentSource);
  return new SQSClient({
    region: environment.AWS_REGION,
    ...(environment.SQS_ENDPOINT === undefined ? {} : { endpoint: environment.SQS_ENDPOINT }),
    credentials: {
      accessKeyId: environment.AWS_ACCESS_KEY_ID,
      secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
    },
  });
}

async function queueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const response = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const arn = response.Attributes?.QueueArn;
  if (arn === undefined) {
    throw new Error('SQS queue ARN is unavailable');
  }
  return arn;
}

export async function createIsolatedCommandQueue(
  client: SQSClient,
  prefix: string,
): Promise<IsolatedCommandQueue> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const deadLetterQueueName = `${prefix}-${suffix}-dlq.fifo`;
  const commandQueueName = `${prefix}-${suffix}.fifo`;
  await client.send(
    new CreateQueueCommand({
      QueueName: deadLetterQueueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  const deadLetterQueueUrl = (
    await client.send(new GetQueueUrlCommand({ QueueName: deadLetterQueueName }))
  ).QueueUrl;
  if (deadLetterQueueUrl === undefined) {
    throw new Error('Dead-letter queue URL is unavailable');
  }
  const deadLetterTargetArn = await queueArn(client, deadLetterQueueUrl);
  await client.send(
    new CreateQueueCommand({
      QueueName: commandQueueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        ReceiveMessageWaitTimeSeconds: '1',
        VisibilityTimeout: '2',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn, maxReceiveCount: '5' }),
      },
    }),
  );
  const commandQueueUrl = (
    await client.send(new GetQueueUrlCommand({ QueueName: commandQueueName }))
  ).QueueUrl;
  if (commandQueueUrl === undefined) {
    throw new Error('Command queue URL is unavailable');
  }

  return Object.freeze({
    commandQueueUrl,
    deadLetterQueueUrl,
    async delete(): Promise<void> {
      await Promise.all([
        client.send(new DeleteQueueCommand({ QueueUrl: commandQueueUrl })),
        client.send(new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl })),
      ]);
    },
  });
}

export function sendWagerCommand(
  client: SQSClient,
  queueUrl: string,
  envelope: WagerCommandEnvelope,
): Promise<unknown> {
  return client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: envelope.data.walletId,
      MessageDeduplicationId: envelope.messageId,
    }),
  );
}

export function startConsumerProcess(
  configuration: ConsumerProcessConfiguration,
): RunningConsumerProcess {
  const markers: ProcessMarker[] = [];
  const waiters = new Set<MarkerWaiter>();
  let standardError = '';
  const handle = Bun.spawn({
    cmd: [process.execPath, import.meta.path],
    cwd: process.cwd(),
    env: {
      ...process.env,
      [PROCESS_CONFIGURATION_VARIABLE]: JSON.stringify(configuration),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ipc: () => undefined,
  });

  void (async () => {
    const reader = handle.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const marker = parseProcessMarker(line);
        if (marker === null) {
          continue;
        }
        markers.push(marker);
        if (marker.event === 'FATAL') {
          for (const waiter of waiters) {
            clearTimeout(waiter.timeout);
            waiters.delete(waiter);
            waiter.reject(
              new Error(`Consumer process failed; markers: ${JSON.stringify(markers)}`),
            );
          }
          continue;
        }
        for (const waiter of waiters) {
          if (waiter.event === marker.event && waiter.predicate(marker)) {
            clearTimeout(waiter.timeout);
            waiters.delete(waiter);
            waiter.resolve(marker);
          }
        }
      }
    }
  })();
  void new Response(handle.stderr).text().then((value) => {
    standardError = value;
  });

  return {
    handle,
    markers,
    standardError: () => standardError,
    async stop(): Promise<number> {
      if (process.platform === 'win32') {
        handle.send({ signal: 'SIGTERM' });
      } else {
        handle.kill('SIGTERM');
      }
      return handle.exited;
    },
    waitForMarker(
      event: string,
      predicate: (marker: ProcessMarker) => boolean = () => true,
      timeoutMs = 30_000,
    ): Promise<ProcessMarker> {
      const existing = markers.find((marker) => marker.event === event && predicate(marker));
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      if (markers.some((marker) => marker.event === 'FATAL')) {
        return Promise.reject(
          new Error(`Consumer process failed; markers: ${JSON.stringify(markers)}`),
        );
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(waiter);
          reject(
            new Error(
              `Timed out waiting for ${event}; stderr: ${standardError}; markers: ${JSON.stringify(markers)}`,
            ),
          );
        }, timeoutMs);
        const waiter: MarkerWaiter = { event, predicate, reject, resolve, timeout };
        waiters.add(waiter);
      });
    },
  };
}

async function runConsumerProcess(): Promise<void> {
  const configuration = parseProcessConfiguration();
  const [
    { createMikroOrmConfig },
    { ConsumerShutdownCoordinator },
    { WagerCommandConsumer },
    { SqsRetryPolicy },
  ] = await Promise.all([
    import('../../src/bootstrap/configuration/mikro-orm.config.js'),
    import('../../src/messaging/infrastructure/consumer-shutdown.js'),
    import('../../src/messaging/infrastructure/wager-command.consumer.js'),
    import('../../src/messaging/infrastructure/sqs-retry-policy.js'),
  ]);
  for (const [key, value] of Object.entries(configuration.environment)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
  const environment = parseEnvironment(configuration.environment);
  const orm = await MikroORM.init(createMikroOrmConfig(environment));
  const sqsClient = createSqsClient(configuration.environment);
  const transactionRunner = new MikroOrmTransactionRunner(orm, (entityManager) =>
    createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
  );
  const failpoints = new ProcessFailpoints(configuration.mode);
  const processWagerTransaction = new ProcessWagerTransactionUseCase(transactionRunner, {
    failpoints,
  });
  const shutdownCoordinator = new ConsumerShutdownCoordinator({
    gracePeriodMs: configuration.gracePeriodMs,
    onTransition: (transition) =>
      void writeMarker({
        event: 'RECEIPT_TRANSITION',
        state: transition.state,
        ...(transition.messageId === undefined ? {} : { messageId: transition.messageId }),
      }),
  });
  const consumer = new WagerCommandConsumer({
    consumerName: configuration.consumerName,
    transactionRunner,
    processWagerTransaction,
    sqsClient,
    queueConfiguration: {
      commandQueueUrl: configuration.commandQueueUrl,
      maxNumberOfMessages: 1,
      visibilityTimeoutSeconds: 2,
      waitTimeSeconds: 1,
    },
    retryPolicy: new SqsRetryPolicy({
      baseVisibilityTimeoutSeconds: 1,
      maxVisibilityTimeoutSeconds: 2,
    }),
    shutdownCoordinator,
    failpoints,
  });
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    const consumerStop = consumer.stop();
    failpoints.releaseForShutdown();
    await consumerStop;
    sqsClient.destroy();
    await orm.close(true);
    await writeMarker({ event: 'STOPPED' });
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  process.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'signal' in message &&
      message.signal === 'SIGTERM'
    ) {
      void stop();
    }
  });
  await consumer.start();
  await writeMarker({ event: 'READY' });
  await new Promise(() => undefined);
}

if (import.meta.main) {
  runConsumerProcess().catch(async (error: unknown) => {
    await writeMarker({ event: 'FATAL' });
    console.error(error);
    process.exit(1);
  });
}
