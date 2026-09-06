import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { ApiDocumentationModule } from './api-documentation/api-documentation.module.js';
import mikroOrmConfig from './bootstrap/configuration/mikro-orm.config.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { HealthModule } from './health/health.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { SqsQueueMetricsModule } from './observability/sqs-queue-metrics.module.js';
import { WalletModule } from './wallet/wallet.module.js';
import { WageringModule } from './wagering/wagering.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    ObservabilityModule,
    SqsQueueMetricsModule,
    ApiDocumentationModule,
    WalletModule,
    WageringModule,
    MessagingModule,
    HealthModule,
  ],
})
export class AppModule {}
