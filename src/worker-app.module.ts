import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';

import mikroOrmConfig from './bootstrap/configuration/mikro-orm.config.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { WageringWorkerModule } from './wagering/wagering-worker.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    ObservabilityModule,
    WageringWorkerModule,
    MessagingModule,
  ],
})
export class WorkerAppModule {}
