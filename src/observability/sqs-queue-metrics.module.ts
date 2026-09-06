import { Module } from '@nestjs/common';

import { parseEnvironment } from '../bootstrap/configuration/environment.schema.js';
import { createSqsClient } from '../messaging/infrastructure/sqs-client.factory.js';
import type { OperationalMetrics } from './application/operational-metrics.js';
import { SqsQueueDepthCollector } from './infrastructure/sqs-queue-depth.collector.js';
import { ObservabilityModule } from './observability.module.js';
import { OBSERVABILITY_METRICS } from './observability.tokens.js';

@Module({
  imports: [ObservabilityModule],
  providers: [
    {
      provide: SqsQueueDepthCollector,
      inject: [OBSERVABILITY_METRICS],
      useFactory: (metrics: OperationalMetrics): SqsQueueDepthCollector => {
        const environment = parseEnvironment();
        return new SqsQueueDepthCollector(createSqsClient(environment), metrics, {
          queues: [
            { name: 'command', url: environment.SQS_COMMAND_QUEUE_URL },
            { name: 'command_dlq', url: environment.SQS_COMMAND_DLQ_URL },
            { name: 'event', url: environment.SQS_EVENT_QUEUE_URL },
          ],
          intervalMs: environment.SQS_QUEUE_METRICS_INTERVAL_MS,
          timeoutMs: environment.SQS_QUEUE_METRICS_TIMEOUT_MS,
        });
      },
    },
  ],
})
export class SqsQueueMetricsModule {}
