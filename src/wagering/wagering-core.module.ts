import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

import {
  DATABASE_TRANSACTION_OPTIONS,
  DatabaseTransactionModule,
} from '../bootstrap/configuration/database-transaction.module.js';
import type { OperationalLogger } from '../observability/application/operational-logger.js';
import type { OperationalMetrics } from '../observability/application/operational-metrics.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import {
  OBSERVABILITY_LOGGER,
  OBSERVABILITY_METRICS,
} from '../observability/observability.tokens.js';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../shared/application/transaction-runner.js';
import { MikroOrmTransactionRunner } from '../shared/infrastructure/mikro-orm-transaction-runner.js';
import type { MikroOrmTransactionRunnerOptions } from '../shared/infrastructure/mikro-orm-transaction-runner.js';
import { GetProviderWagerTransactionUseCase } from './application/get-provider-wager-transaction.use-case.js';
import { GetWagerTransactionUseCase } from './application/get-wager-transaction.use-case.js';
import type { WageringTransactionContext } from './application/ports/wagering-transaction-context.js';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case.js';
import { createWageringTransactionContext } from './infrastructure/persistence/wagering-transaction-context.js';

type WageringRunner = TransactionRunner<WageringTransactionContext>;

@Module({
  imports: [DatabaseTransactionModule, ObservabilityModule],
  providers: [
    {
      provide: TRANSACTION_RUNNER,
      inject: [MikroORM, OBSERVABILITY_METRICS, DATABASE_TRANSACTION_OPTIONS],
      useFactory: (
        orm: MikroORM,
        metrics: OperationalMetrics,
        options: MikroOrmTransactionRunnerOptions,
      ): WageringRunner =>
        new MikroOrmTransactionRunner(
          orm,
          (entityManager) =>
            createWageringTransactionContext(entityManager, metrics.walletLockMetrics),
          undefined,
          options,
        ),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [TRANSACTION_RUNNER, OBSERVABILITY_LOGGER, OBSERVABILITY_METRICS],
      useFactory: (
        runner: WageringRunner,
        logger: OperationalLogger,
        metrics: OperationalMetrics,
      ): ProcessWagerTransactionUseCase =>
        new ProcessWagerTransactionUseCase(runner, { logger, metrics }),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [TRANSACTION_RUNNER],
      useFactory: (runner: WageringRunner): GetWagerTransactionUseCase =>
        new GetWagerTransactionUseCase(runner),
    },
    {
      provide: GetProviderWagerTransactionUseCase,
      inject: [TRANSACTION_RUNNER],
      useFactory: (runner: WageringRunner): GetProviderWagerTransactionUseCase =>
        new GetProviderWagerTransactionUseCase(runner),
    },
  ],
  exports: [
    TRANSACTION_RUNNER,
    ProcessWagerTransactionUseCase,
    GetWagerTransactionUseCase,
    GetProviderWagerTransactionUseCase,
  ],
})
export class WageringCoreModule {}
