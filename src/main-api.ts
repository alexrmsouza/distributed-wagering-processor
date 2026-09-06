import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { ApiAppModule } from './api-app.module.js';
import { parseEnvironment } from './bootstrap/configuration/environment.schema.js';

async function bootstrap(): Promise<void> {
  const environment = parseEnvironment();
  const application = await NestFactory.create(ApiAppModule);

  application.enableShutdownHooks();
  await application.listen(environment.APP_PORT, environment.APP_HOST);
}

bootstrap().catch(() => {
  console.error('API startup failed');
  process.exitCode = 1;
});
