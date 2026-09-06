import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import {
  createWalletRequestSchema,
  ledgerLimitSchema,
  walletIdSchema,
} from '../../api-documentation/http-contract.schemas.js';
import { Money } from '../../shared/domain/money.js';
import { CreateWalletUseCase } from '../application/create-wallet.use-case.js';
import { GetWalletUseCase } from '../application/get-wallet.use-case.js';
import { ListWalletLedgerUseCase } from '../application/list-wallet-ledger.use-case.js';
import { ReconcileWalletUseCase } from '../application/reconcile-wallet.use-case.js';
import { LedgerPresenter } from './ledger.presenter.js';
import { ReconciliationPresenter } from './reconciliation.presenter.js';
import { WalletAuthenticationGuard } from './wallet-authentication.guard.js';
import { toWalletHttpException } from './wallet-http-error.js';
import { WalletPresenter } from './wallet.presenter.js';

@Controller('wallets')
@UseGuards(WalletAuthenticationGuard)
export class WalletController {
  public constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListWalletLedgerUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  public async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    try {
      const input = createWalletRequestSchema.parse(body);
      const wallet = await this.createWallet.execute({
        playerId: input.playerId,
        initialBalance: Money.create(input.initialBalance),
        ...(correlationId === undefined ? {} : { correlationId }),
      });
      return WalletPresenter.present(wallet);
    } catch (error: unknown) {
      throw toWalletHttpException(error);
    }
  }

  @Get(':walletId/ledger')
  public async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') rawLimit: string | undefined,
  ) {
    try {
      const parsedWalletId = walletIdSchema.parse(walletId);
      const limit = rawLimit === undefined ? undefined : ledgerLimitSchema.parse(rawLimit);
      const page = await this.listLedger.execute({
        walletId: parsedWalletId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      });
      return LedgerPresenter.present(page);
    } catch (error: unknown) {
      throw toWalletHttpException(error);
    }
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  public async reconcile(@Param('walletId') walletId: string) {
    try {
      const result = await this.reconcileWallet.execute(walletIdSchema.parse(walletId));
      return ReconciliationPresenter.present(result);
    } catch (error: unknown) {
      throw toWalletHttpException(error);
    }
  }

  @Get(':walletId')
  public async get(@Param('walletId') walletId: string) {
    try {
      const wallet = await this.getWallet.execute(walletIdSchema.parse(walletId));
      return WalletPresenter.present(wallet);
    } catch (error: unknown) {
      throw toWalletHttpException(error);
    }
  }
}
