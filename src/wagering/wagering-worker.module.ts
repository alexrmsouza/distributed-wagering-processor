import { Module } from '@nestjs/common';

import type { OperationalMetrics } from '../observability/application/operational-metrics.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { OBSERVABILITY_METRICS } from '../observability/observability.tokens.js';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../shared/application/transaction-runner.js';
import type { WageringTransactionContext } from './application/ports/wagering-transaction-context.js';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case.js';
import { PendingReferenceWorker } from './infrastructure/pending-reference.worker.js';
import { WageringCoreModule } from './wagering-core.module.js';

type WageringRunner = TransactionRunner<WageringTransactionContext>;

@Module({
  imports: [WageringCoreModule, ObservabilityModule],
  providers: [
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
  ],
})
export class WageringWorkerModule {}
