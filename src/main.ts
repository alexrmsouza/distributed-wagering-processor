import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { parseEnvironment } from './bootstrap/configuration/environment.schema.js';

async function bootstrap(): Promise<void> {
  const environment = parseEnvironment();
  const application = await NestFactory.create(AppModule);

  application.enableShutdownHooks();
  await application.listen(environment.APP_PORT, environment.APP_HOST);
}

bootstrap().catch(() => {
  console.error('Application startup failed');
  process.exitCode = 1;
});
