import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import mikroOrmConfig from './bootstrap/configuration/mikro-orm.config.js';
import { parseEnvironment } from './bootstrap/configuration/environment.schema.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { HealthModule } from './health/health.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { WalletModule } from './wallet/wallet.module.js';
import { WageringModule } from './wagering/wagering.module.js';

const ENVIRONMENT = Symbol('ENVIRONMENT');

const environment = parseEnvironment();

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    ObservabilityModule,
    WalletModule,
    WageringModule,
    MessagingModule,
    HealthModule,
  ],
  providers: [
    {
      provide: ENVIRONMENT,
      useValue: environment,
    },
  ],
})
export class AppModule {}
