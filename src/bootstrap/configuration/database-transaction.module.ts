import { Module } from '@nestjs/common';

import type { MikroOrmTransactionRunnerOptions } from '../../shared/infrastructure/mikro-orm-transaction-runner.js';
import { parseEnvironment } from './environment.schema.js';

export const DATABASE_TRANSACTION_OPTIONS = Symbol('DATABASE_TRANSACTION_OPTIONS');

@Module({
  providers: [
    {
      provide: DATABASE_TRANSACTION_OPTIONS,
      useFactory: (): MikroOrmTransactionRunnerOptions => {
        const environment = parseEnvironment();
        return Object.freeze({
          lockTimeoutMs: environment.DATABASE_LOCK_TIMEOUT_MS,
          statementTimeoutMs: environment.DATABASE_STATEMENT_TIMEOUT_MS,
          maxAttempts: environment.DATABASE_TRANSACTION_MAX_ATTEMPTS,
          retryBaseDelayMs: environment.DATABASE_TRANSACTION_RETRY_BASE_DELAY_MS,
        });
      },
    },
  ],
  exports: [DATABASE_TRANSACTION_OPTIONS],
})
export class DatabaseTransactionModule {}
