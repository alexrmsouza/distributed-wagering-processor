import { Module } from '@nestjs/common';

import { parseEnvironment } from '../bootstrap/configuration/environment.schema.js';
import type { OperationalLogger } from '../observability/application/operational-logger.js';
import type { OperationalMetrics } from '../observability/application/operational-metrics.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import {
  OBSERVABILITY_LOGGER,
  OBSERVABILITY_METRICS,
} from '../observability/observability.tokens.js';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../shared/application/transaction-runner.js';
import type { WageringTransactionContext } from '../wagering/application/ports/wagering-transaction-context.js';
import { ProcessWagerTransactionUseCase } from '../wagering/application/process-wager-transaction.use-case.js';
import { WageringModule } from '../wagering/wagering.module.js';
import { ConsumerShutdownCoordinator } from './infrastructure/consumer-shutdown.js';
import { SqsIntegrationEventPublisher } from './infrastructure/integration-event.publisher.js';
import { OutboxWorker } from './infrastructure/outbox.worker.js';
import {
  createSqsClient,
  createSqsQueueConfiguration,
} from './infrastructure/sqs-client.factory.js';
import { SqsRetryPolicy } from './infrastructure/sqs-retry-policy.js';
import { WagerCommandConsumer } from './infrastructure/wager-command.consumer.js';

const environment = parseEnvironment();
const SQS_CLIENT = Symbol('SQS_CLIENT');
type WageringRunner = TransactionRunner<WageringTransactionContext>;

@Module({
  imports: [WageringModule, ObservabilityModule],
  providers: [
    {
      provide: SQS_CLIENT,
      useFactory: () => createSqsClient(environment),
    },
    {
      provide: WagerCommandConsumer,
      inject: [
        SQS_CLIENT,
        TRANSACTION_RUNNER,
        ProcessWagerTransactionUseCase,
        OBSERVABILITY_LOGGER,
        OBSERVABILITY_METRICS,
      ],
      useFactory: (
        sqsClient: ReturnType<typeof createSqsClient>,
        transactionRunner: WageringRunner,
        processWagerTransaction: ProcessWagerTransactionUseCase,
        logger: OperationalLogger,
        metrics: OperationalMetrics,
      ): WagerCommandConsumer =>
        new WagerCommandConsumer({
          consumerName: environment.SQS_CONSUMER_NAME,
          transactionRunner,
          processWagerTransaction,
          sqsClient,
          queueConfiguration: createSqsQueueConfiguration(environment),
          retryPolicy: new SqsRetryPolicy({
            baseVisibilityTimeoutSeconds: 30,
            maxVisibilityTimeoutSeconds: 3600,
          }),
          shutdownCoordinator: new ConsumerShutdownCoordinator({
            gracePeriodMs: environment.SQS_SHUTDOWN_GRACE_PERIOD_MS,
          }),
          enabled: environment.SQS_CONSUMER_ENABLED,
          logger,
          metrics,
        }),
    },
    {
      provide: SqsIntegrationEventPublisher,
      inject: [SQS_CLIENT],
      useFactory: (sqsClient: ReturnType<typeof createSqsClient>): SqsIntegrationEventPublisher =>
        new SqsIntegrationEventPublisher(sqsClient, environment.SQS_EVENT_QUEUE_URL),
    },
    {
      provide: OutboxWorker,
      inject: [
        TRANSACTION_RUNNER,
        SqsIntegrationEventPublisher,
        OBSERVABILITY_LOGGER,
        OBSERVABILITY_METRICS,
      ],
      useFactory: (
        transactionRunner: WageringRunner,
        publisher: SqsIntegrationEventPublisher,
        logger: OperationalLogger,
        metrics: OperationalMetrics,
      ): OutboxWorker =>
        new OutboxWorker(transactionRunner, publisher, {
          enabled: environment.OUTBOX_PUBLISHER_ENABLED,
          batchSize: environment.OUTBOX_PUBLISHER_BATCH_SIZE,
          leaseDurationMs: environment.OUTBOX_PUBLISHER_LEASE_DURATION_MS,
          pollIntervalMs: environment.OUTBOX_PUBLISHER_POLL_INTERVAL_MS,
          shutdownGracePeriodMs: environment.OUTBOX_PUBLISHER_SHUTDOWN_GRACE_PERIOD_MS,
          logger,
          metrics,
        }),
    },
  ],
})
export class MessagingModule {}
