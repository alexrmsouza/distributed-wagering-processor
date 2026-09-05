import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

import { parseEnvironment } from '../bootstrap/configuration/environment.schema.js';
import { createSqsClient } from '../messaging/infrastructure/sqs-client.factory.js';
import { HealthService } from './application/health.service.js';
import { PostgresReadinessProbe, SqsReadinessProbe } from './infrastructure/readiness.probes.js';
import { HealthController } from './presentation/health.controller.js';

const environment = parseEnvironment();
const readinessSqsClient = createSqsClient(environment);

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: HealthService,
      inject: [MikroORM],
      useFactory: (orm: MikroORM): HealthService =>
        new HealthService({
          database: new PostgresReadinessProbe(orm),
          sqs: new SqsReadinessProbe(
            readinessSqsClient,
            [
              environment.SQS_COMMAND_QUEUE_URL,
              environment.SQS_COMMAND_DLQ_URL,
              environment.SQS_EVENT_QUEUE_URL,
            ],
            true,
          ),
          timeoutMs: environment.HEALTH_READINESS_TIMEOUT_MS,
        }),
    },
  ],
})
export class HealthModule {}
