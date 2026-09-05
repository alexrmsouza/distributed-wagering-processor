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
import { AUTHENTICATION_GUARD, NoOpAuthGuard } from '../shared/infrastructure/no-op-auth.guard.js';
import { MikroOrmTransactionRunner } from '../shared/infrastructure/mikro-orm-transaction-runner.js';
import { CreateWalletUseCase } from './application/create-wallet.use-case.js';
import { GetWalletUseCase } from './application/get-wallet.use-case.js';
import { ListWalletLedgerUseCase } from './application/list-wallet-ledger.use-case.js';
import type { WalletTransactionContext } from './application/ports/wallet-transaction-context.js';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case.js';
import { createWalletTransactionContext } from './infrastructure/persistence/wallet-transaction-context.js';
import { WalletAuthenticationGuard } from './presentation/wallet-authentication.guard.js';
import { WalletController } from './presentation/wallet.controller.js';

type WalletRunner = TransactionRunner<WalletTransactionContext>;

@Module({
  imports: [ObservabilityModule],
  controllers: [WalletController],
  providers: [
    NoOpAuthGuard,
    {
      provide: AUTHENTICATION_GUARD,
      useExisting: NoOpAuthGuard,
    },
    WalletAuthenticationGuard,
    {
      provide: TRANSACTION_RUNNER,
      inject: [MikroORM],
      useFactory: (orm: MikroORM): WalletRunner =>
        new MikroOrmTransactionRunner(orm, createWalletTransactionContext),
    },
    {
      provide: CreateWalletUseCase,
      inject: [TRANSACTION_RUNNER],
      useFactory: (runner: WalletRunner): CreateWalletUseCase => new CreateWalletUseCase(runner),
    },
    {
      provide: GetWalletUseCase,
      inject: [TRANSACTION_RUNNER],
      useFactory: (runner: WalletRunner): GetWalletUseCase => new GetWalletUseCase(runner),
    },
    {
      provide: ListWalletLedgerUseCase,
      inject: [TRANSACTION_RUNNER],
      useFactory: (runner: WalletRunner): ListWalletLedgerUseCase =>
        new ListWalletLedgerUseCase(runner),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [TRANSACTION_RUNNER, OBSERVABILITY_LOGGER, OBSERVABILITY_METRICS],
      useFactory: (
        runner: WalletRunner,
        logger: OperationalLogger,
        metrics: OperationalMetrics,
      ): ReconcileWalletUseCase => new ReconcileWalletUseCase(runner, { logger, metrics }),
    },
  ],
})
export class WalletModule {}
