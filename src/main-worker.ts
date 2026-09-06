import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { WorkerAppModule } from './worker-app.module.js';

async function bootstrap(): Promise<void> {
  const application = await NestFactory.createApplicationContext(WorkerAppModule);
  application.enableShutdownHooks();
}

bootstrap().catch(() => {
  console.error('Worker startup failed');
  process.exitCode = 1;
});
