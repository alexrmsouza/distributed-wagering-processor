import { Module } from '@nestjs/common';

import { AUTHENTICATION_GUARD, NoOpAuthGuard } from '../shared/infrastructure/no-op-auth.guard.js';
import { WageringAuthenticationGuard } from './presentation/wagering-authentication.guard.js';
import { WageringController } from './presentation/wagering.controller.js';
import { WageringCoreModule } from './wagering-core.module.js';

@Module({
  imports: [WageringCoreModule],
  controllers: [WageringController],
  providers: [
    NoOpAuthGuard,
    {
      provide: AUTHENTICATION_GUARD,
      useExisting: NoOpAuthGuard,
    },
    WageringAuthenticationGuard,
  ],
})
export class WageringHttpModule {}
