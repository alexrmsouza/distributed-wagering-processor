import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import type { OperationalLogger } from '../../observability/application/operational-logger.js';
import { NOOP_OPERATIONAL_LOGGER } from '../../observability/application/operational-logger.js';
import type { OperationalMetrics } from '../../observability/application/operational-metrics.js';
import { NOOP_OPERATIONAL_METRICS } from '../../observability/application/operational-metrics.js';
import { SystemClock, type Clock } from '../../shared/application/clock.js';
import { createCorrelationContext } from '../../shared/application/correlation-context.js';
import type { TransactionRunner } from '../../shared/application/transaction-runner.js';
import type { FailpointPort } from '../../shared/infrastructure/failpoints/failpoint.port.js';
import type { WageringTransactionContext } from '../../wagering/application/ports/wagering-transaction-context.js';
import type {
  ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
  ProcessableWagerKind,
} from '../../wagering/application/process-wager-transaction.use-case.js';
import { IdempotencyConflictError } from '../../wagering/application/wagering-errors.js';
import { InboxMessage } from '../domain/inbox-message.js';
import { ConsumerShutdownCoordinator } from './consumer-shutdown.js';
import type { SqsQueueConfiguration } from './sqs-client.factory.js';
import { SqsRetryPolicy, type SqsFailureAction } from './sqs-retry-policy.js';
import {
  MalformedWagerCommandError,
  WagerCommandMapper,
  type MappedWagerCommand,
} from './wager-command.mapper.js';

class DivergentInboxEnvelopeError extends Error {
  public readonly code = 'IDEMPOTENCY_CONFLICT';
  public readonly redrive = true;

  public constructor() {
    super('Inbox identity was reused with a divergent envelope');
    this.name = 'DivergentInboxEnvelopeError';
  }
}

class IncompleteInboxMessageError extends Error {
  public readonly classification = 'TRANSIENT_INFRASTRUCTURE';

  public constructor() {
    super('Inbox message does not have a committed result');
    this.name = 'IncompleteInboxMessageError';
  }
}

interface WagerCommandConflictOutcome {
  readonly transactionId: string | null;
  readonly status: 'CONFLICT';
  readonly failureCode: 'IDEMPOTENCY_CONFLICT';
  readonly idempotentReplay: false;
}

export interface WagerCommandProcessingResult {
  readonly action: 'ACK';
  readonly outcome: ProcessWagerTransactionResult | WagerCommandConflictOutcome;
}

export interface WagerCommandDeliveryResult {
  readonly action: 'ACK' | SqsFailureAction;
  readonly outcome?: ProcessWagerTransactionResult | WagerCommandConflictOutcome;
}

export interface WagerCommandConsumerDependencies {
  readonly consumerName: string;
  readonly transactionRunner: TransactionRunner<WageringTransactionContext>;
  readonly processWagerTransaction: ProcessWagerTransactionUseCase;
  readonly sqsClient: SQSClient;
  readonly queueConfiguration: SqsQueueConfiguration;
  readonly retryPolicy?: SqsRetryPolicy;
  readonly shutdownCoordinator?: ConsumerShutdownCoordinator;
  readonly failpoints?: FailpointPort;
  readonly clock?: Clock;
  readonly enabled?: boolean;
  readonly logger?: OperationalLogger;
  readonly metrics?: OperationalMetrics;
}

const NOOP_FAILPOINTS: FailpointPort = Object.freeze({ trigger: () => Promise.resolve() });

export class WagerCommandConsumer implements OnModuleInit, OnModuleDestroy {
  readonly #consumerName: string;
  readonly #transactionRunner: TransactionRunner<WageringTransactionContext>;
  readonly #processWagerTransaction: ProcessWagerTransactionUseCase;
  readonly #sqsClient: SQSClient;
  readonly #queueConfiguration: SqsQueueConfiguration;
  readonly #retryPolicy: SqsRetryPolicy;
  readonly #shutdownCoordinator: ConsumerShutdownCoordinator;
  readonly #failpoints: FailpointPort;
  readonly #clock: Clock;
  readonly #enabled: boolean;
  readonly #logger: OperationalLogger;
  readonly #metrics: OperationalMetrics;
  readonly #activeDeliveries = new Set<Promise<unknown>>();
  #pollAbortController: AbortController | undefined;
  #polling: Promise<void> | undefined;
  #running = false;

  public constructor(dependencies: WagerCommandConsumerDependencies) {
    this.#consumerName = dependencies.consumerName;
    this.#transactionRunner = dependencies.transactionRunner;
    this.#processWagerTransaction = dependencies.processWagerTransaction;
    this.#sqsClient = dependencies.sqsClient;
    this.#queueConfiguration = dependencies.queueConfiguration;
    this.#retryPolicy =
      dependencies.retryPolicy ??
      new SqsRetryPolicy({
        baseVisibilityTimeoutSeconds: 30,
        maxVisibilityTimeoutSeconds: 3600,
      });
    this.#shutdownCoordinator =
      dependencies.shutdownCoordinator ??
      new ConsumerShutdownCoordinator({ gracePeriodMs: 10_000 });
    this.#failpoints = dependencies.failpoints ?? NOOP_FAILPOINTS;
    this.#clock = dependencies.clock ?? new SystemClock();
    this.#enabled = dependencies.enabled ?? true;
    this.#logger = dependencies.logger ?? NOOP_OPERATIONAL_LOGGER;
    this.#metrics = dependencies.metrics ?? NOOP_OPERATIONAL_METRICS;
  }

  public onModuleInit(): Promise<void> {
    return this.#enabled ? this.start() : Promise.resolve();
  }

  public async onModuleDestroy(): Promise<void> {
    await this.stop();
    this.#sqsClient.destroy();
  }

  public start(): Promise<void> {
    if (this.#running) {
      return Promise.resolve();
    }
    this.#running = true;
    this.#pollAbortController = new AbortController();
    this.#polling = this.#poll(this.#pollAbortController.signal);
    return Promise.resolve();
  }

  public async stop(): Promise<void> {
    if (!this.#running && this.#polling === undefined) {
      return;
    }
    this.#running = false;
    this.#shutdownCoordinator.stopAccepting();
    this.#pollAbortController?.abort();
    const polling = this.#polling;

    const settled = Promise.allSettled([...this.#activeDeliveries]).then(() => true);
    const shutdownAbortController = new AbortController();
    let graceTimeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      graceTimeout = setTimeout(() => {
        shutdownAbortController.abort();
        resolve();
      }, this.#shutdownCoordinator.gracePeriodMs);
    });
    const deliveriesSettled = await Promise.race([settled, deadline.then(() => false)]);

    const activeReceipts = this.#shutdownCoordinator.activeReceipts();
    for (const receipt of activeReceipts) {
      this.#shutdownCoordinator.transition(receipt.receiptHandle, 'released');
    }
    const releases = Promise.allSettled(
      activeReceipts.map((receipt) =>
        this.#changeVisibility(receipt.receiptHandle, 0, shutdownAbortController.signal),
      ),
    );
    await Promise.race([releases.then(() => undefined), deadline]);
    if (polling !== undefined) {
      await Promise.race([polling.catch(() => undefined), deadline]);
      if (!deliveriesSettled) {
        void polling.catch(() => undefined);
      }
    }
    if (graceTimeout !== undefined) {
      clearTimeout(graceTimeout);
    }
    shutdownAbortController.abort();
    this.#polling = undefined;
    this.#pollAbortController = undefined;
  }

  public processEnvelope(body: string): Promise<WagerCommandProcessingResult> {
    return this.#processMappedEnvelope(WagerCommandMapper.map(body));
  }

  public async processMessage(message: Message): Promise<WagerCommandDeliveryResult> {
    const body = message.Body;
    const receiptHandle = message.ReceiptHandle;
    if (body === undefined || receiptHandle === undefined) {
      throw new MalformedWagerCommandError();
    }

    let mapped: MappedWagerCommand | undefined;
    try {
      mapped = WagerCommandMapper.map(body);
    } catch {
      mapped = undefined;
    }
    this.#shutdownCoordinator.register(
      receiptHandle,
      mapped?.envelope.messageId ?? message.MessageId,
    );
    this.#shutdownCoordinator.transition(receiptHandle, 'processing');
    const startedAt = performance.now();
    if (mapped !== undefined) {
      this.safeLog('received', mapped);
    }

    try {
      const result =
        mapped === undefined
          ? await this.processEnvelope(body)
          : await this.#processMappedEnvelope(mapped);
      this.#shutdownCoordinator.transition(receiptHandle, 'committed');
      if (mapped !== undefined) {
        this.safeLog('transaction_committed', mapped, result.outcome.transactionId);
      }
      this.observeCommittedOutcome(result, mapped?.command.kind, startedAt);
      await this.#failpoints.trigger('after_financial_commit_before_sqs_ack');
      await this.#sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: this.#queueConfiguration.commandQueueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
      this.#shutdownCoordinator.transition(receiptHandle, 'acknowledged');
      if (mapped !== undefined) {
        this.safeLog('acknowledged', mapped, result.outcome.transactionId);
      }
      return result;
    } catch (error: unknown) {
      const action = this.#retryPolicy.classify(error);
      this.observeFailure(action, mapped === undefined);
      const shuttingDown = !this.#shutdownCoordinator.accepting;
      const visibilityTimeout =
        action === 'REDRIVE' || shuttingDown
          ? 0
          : this.#retryPolicy.visibilityTimeoutSeconds(this.#receiveCount(message));
      this.#shutdownCoordinator.transition(receiptHandle, 'retryable');
      await this.#changeVisibility(receiptHandle, visibilityTimeout);
      this.#shutdownCoordinator.transition(receiptHandle, 'released');
      return Object.freeze({ action });
    }
  }

  async #processMappedEnvelope(mapped: MappedWagerCommand): Promise<WagerCommandProcessingResult> {
    return this.#transactionRunner.run(async (context) => {
      const receivedAt = this.#clock.now();
      const candidate = InboxMessage.create({
        consumerName: this.#consumerName,
        messageId: mapped.envelope.messageId,
        payloadHash: mapped.payloadHash,
        receivedAt,
      });
      const claim = await context.inbox.claim(candidate);

      if (claim === 'DUPLICATE') {
        const existing = await context.inbox.find(this.#consumerName, mapped.envelope.messageId);
        if (existing === null) {
          throw new IncompleteInboxMessageError();
        }
        if (existing.payloadHash !== mapped.payloadHash) {
          this.safeMetric(() => {
            this.#metrics.recordInbox('conflict');
          });
          throw new DivergentInboxEnvelopeError();
        }
        if (existing.processedAt === null) {
          throw new IncompleteInboxMessageError();
        }
        this.safeMetric(() => {
          this.#metrics.recordInbox('duplicate');
        });
        if (existing.transactionId !== null) {
          const outcome = await this.#processWagerTransaction.replayResultInContext(
            context,
            existing.transactionId,
          );
          if (outcome !== null) {
            return Object.freeze({ action: 'ACK', outcome });
          }
        }

        return this.#processUnlinkedDuplicate(context, mapped);
      }

      try {
        const outcome = await this.#processWagerTransaction.executeInContext(
          context,
          mapped.command,
        );
        const persisted = await context.wagerTransactions.findById(outcome.transactionId);
        await context.inbox.save(candidate.complete(persisted?.id ?? null, this.#clock.now()));
        this.safeMetric(() => {
          this.#metrics.recordInbox('completed');
        });
        return Object.freeze({ action: 'ACK', outcome });
      } catch (error: unknown) {
        if (!(error instanceof IdempotencyConflictError)) {
          throw error;
        }
        await context.inbox.save(candidate.complete(null, this.#clock.now()));
        this.safeMetric(() => {
          this.#metrics.recordInbox('conflict');
        });
        return Object.freeze({
          action: 'ACK',
          outcome: await this.#conflictOutcome(context, mapped),
        });
      }
    });
  }

  async #processUnlinkedDuplicate(
    context: WageringTransactionContext,
    mapped: MappedWagerCommand,
  ): Promise<WagerCommandProcessingResult> {
    try {
      const outcome = await this.#processWagerTransaction.executeInContext(context, mapped.command);
      return Object.freeze({
        action: 'ACK',
        outcome: Object.freeze({ ...outcome, idempotentReplay: true }),
      });
    } catch (error: unknown) {
      if (!(error instanceof IdempotencyConflictError)) {
        throw error;
      }
      return Object.freeze({
        action: 'ACK',
        outcome: await this.#conflictOutcome(context, mapped),
      });
    }
  }

  async #conflictOutcome(
    context: WageringTransactionContext,
    mapped: MappedWagerCommand,
  ): Promise<WagerCommandConflictOutcome> {
    const existing =
      (await context.wagerTransactions.findByIdempotencyKey(
        mapped.command.providerId,
        mapped.command.idempotencyKey,
      )) ??
      (await context.wagerTransactions.findByProviderAndExternalId(
        mapped.command.providerId,
        mapped.command.externalTransactionId,
      ));
    return Object.freeze({
      transactionId: existing?.id ?? null,
      status: 'CONFLICT',
      failureCode: 'IDEMPOTENCY_CONFLICT',
      idempotentReplay: false,
    });
  }

  async #poll(signal: AbortSignal): Promise<void> {
    while (this.#running && this.#shutdownCoordinator.accepting) {
      try {
        const response = await this.#sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: this.#queueConfiguration.commandQueueUrl,
            MaxNumberOfMessages: this.#queueConfiguration.maxNumberOfMessages ?? 10,
            WaitTimeSeconds: this.#queueConfiguration.waitTimeSeconds ?? 20,
            VisibilityTimeout: this.#queueConfiguration.visibilityTimeoutSeconds ?? 30,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          { abortSignal: signal },
        );
        const deliveries: Promise<unknown>[] = [];
        for (const message of response.Messages ?? []) {
          if (signal.aborted) {
            break;
          }
          const delivery = this.processMessage(message);
          this.#activeDeliveries.add(delivery);
          void delivery.finally(() => this.#activeDeliveries.delete(delivery));
          deliveries.push(delivery);
        }
        if (deliveries.length > 0) {
          await Promise.allSettled(deliveries);
        }
      } catch {
        if (signal.aborted) {
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  #receiveCount(message: Message): number {
    const raw = message.Attributes?.ApproximateReceiveCount;
    const value = raw === undefined ? 1 : Number(raw);
    return Number.isInteger(value) && value > 0 ? value : 1;
  }

  async #changeVisibility(
    receiptHandle: string,
    visibilityTimeout: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    await this.#sqsClient.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.#queueConfiguration.commandQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeout,
      }),
      abortSignal === undefined ? undefined : { abortSignal },
    );
  }

  private safeLog(
    event: 'received' | 'transaction_committed' | 'acknowledged',
    mapped: MappedWagerCommand,
    transactionId?: string | null,
  ): void {
    try {
      this.#logger.info(
        event,
        createCorrelationContext({
          correlationId: mapped.envelope.messageId,
          messageId: mapped.envelope.messageId,
          walletId: mapped.command.walletId,
          providerId: mapped.command.providerId,
          ...(transactionId === undefined || transactionId === null ? {} : { transactionId }),
          causationId: mapped.envelope.messageId,
        }),
      );
    } catch {
      // Diagnostics must not change queue acknowledgment behavior.
    }
  }

  private observeCommittedOutcome(
    result: WagerCommandProcessingResult,
    kind: ProcessableWagerKind | undefined,
    startedAt: number,
  ): void {
    this.safeMetric(() => {
      this.#metrics.observeProcessingDuration((performance.now() - startedAt) / 1_000, 'sqs');
    });
    const status = result.outcome.status;
    if (status !== 'CONFLICT' && kind !== undefined) {
      this.safeMetric(() => {
        this.#metrics.recordTransaction(status, kind, 'sqs');
      });
      if (result.outcome.idempotentReplay) {
        this.safeMetric(() => {
          this.#metrics.recordDuplicate('sqs_command');
        });
      }
    }
  }

  private observeFailure(action: SqsFailureAction, malformed: boolean): void {
    if (action === 'REDRIVE') {
      this.safeMetric(() => {
        this.#metrics.recordDeadLetter(malformed ? 'malformed_envelope' : 'permanent_transport');
      });
      return;
    }
    this.safeMetric(() => {
      this.#metrics.recordInbox('retryable');
    });
    this.safeMetric(() => {
      this.#metrics.recordRetry('sqs_command');
    });
  }

  private safeMetric(record: () => void): void {
    try {
      record();
    } catch {
      // Metrics must not change queue acknowledgment behavior.
    }
  }
}
