import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

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
import { AUTHENTICATION_GUARD, NoOpAuthGuard } from '../shared/infrastructure/no-op-auth.guard.js';
import { GetProviderWagerTransactionUseCase } from './application/get-provider-wager-transaction.use-case.js';
import { GetWagerTransactionUseCase } from './application/get-wager-transaction.use-case.js';
import type { WageringTransactionContext } from './application/ports/wagering-transaction-context.js';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case.js';
import { PendingReferenceWorker } from './infrastructure/pending-reference.worker.js';
import { createWageringTransactionContext } from './infrastructure/persistence/wagering-transaction-context.js';
import { WageringAuthenticationGuard } from './presentation/wagering-authentication.guard.js';
import { WageringController } from './presentation/wagering.controller.js';

type WageringRunner = TransactionRunner<WageringTransactionContext>;

@Module({
  imports: [ObservabilityModule],
  controllers: [WageringController],
  providers: [
    NoOpAuthGuard,
    {
      provide: AUTHENTICATION_GUARD,
      useExisting: NoOpAuthGuard,
    },
    WageringAuthenticationGuard,
    {
      provide: TRANSACTION_RUNNER,
      inject: [MikroORM, OBSERVABILITY_METRICS],
      useFactory: (orm: MikroORM, metrics: OperationalMetrics): WageringRunner =>
        new MikroOrmTransactionRunner(orm, (entityManager) =>
          createWageringTransactionContext(entityManager, metrics.walletLockMetrics),
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
      provide: PendingReferenceWorker,
      inject: [TRANSACTION_RUNNER, ProcessWagerTransactionUseCase, OBSERVABILITY_METRICS],
      useFactory: (
        runner: WageringRunner,
        processWagerTransaction: ProcessWagerTransactionUseCase,
        metrics: OperationalMetrics,
      ): PendingReferenceWorker =>
        new PendingReferenceWorker(runner, processWagerTransaction, { metrics }),
    },
    {
      provide: GetProviderWagerTransactionUseCase,
      inject: [TRANSACTION_RUNNER],
      useFactory: (runner: WageringRunner): GetProviderWagerTransactionUseCase =>
        new GetProviderWagerTransactionUseCase(runner),
    },
  ],
  exports: [TRANSACTION_RUNNER, ProcessWagerTransactionUseCase],
})
export class WageringModule {}
