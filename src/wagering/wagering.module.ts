import { Module } from '@nestjs/common';

import { WageringHttpModule } from './wagering-http.module.js';
import { WageringWorkerModule } from './wagering-worker.module.js';

@Module({
  imports: [WageringHttpModule, WageringWorkerModule],
})
export class WageringModule {}
