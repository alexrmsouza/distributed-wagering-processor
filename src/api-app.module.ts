import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';

import { ApiDocumentationModule } from './api-documentation/api-documentation.module.js';
import mikroOrmConfig from './bootstrap/configuration/mikro-orm.config.js';
import { HealthModule } from './health/health.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { SqsQueueMetricsModule } from './observability/sqs-queue-metrics.module.js';
import { WageringHttpModule } from './wagering/wagering-http.module.js';
import { WalletModule } from './wallet/wallet.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    ObservabilityModule,
    SqsQueueMetricsModule,
    ApiDocumentationModule,
    WalletModule,
    WageringHttpModule,
    HealthModule,
  ],
})
export class ApiAppModule {}
