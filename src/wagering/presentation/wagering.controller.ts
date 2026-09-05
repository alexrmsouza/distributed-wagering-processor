import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { Money } from '../../shared/domain/money.js';
import { toHttpException } from '../../shared/infrastructure/http-error.filter.js';
import { GetProviderWagerTransactionUseCase } from '../application/get-provider-wager-transaction.use-case.js';
import { GetWagerTransactionUseCase } from '../application/get-wager-transaction.use-case.js';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.use-case.js';
import { WageringAuthenticationGuard } from './wagering-authentication.guard.js';
import { WagerTransactionPresenter } from './wager-transaction.presenter.js';

const wagerRequestSchema = z
  .object({
    providerId: z.string().trim().min(1).max(128),
    externalTransactionId: z.string().trim().min(1).max(255),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: z.string().trim().min(1).max(255),
    gameId: z.string().trim().min(1).max(255),
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
    money: z
      .object({
        amount: z.string(),
        currency: z.string(),
      })
      .strict(),
    referenceExternalTransactionId: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
const transactionIdSchema = z.uuid();
const providerIdentifierSchema = z.string().trim().min(1).max(255);
const idempotencyKeySchema = z.string().trim().min(1).max(255);

@Controller()
@UseGuards(WageringAuthenticationGuard)
export class WageringController {
  public constructor(
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    private readonly getWagerTransaction: GetWagerTransactionUseCase,
    private readonly getProviderWagerTransaction: GetProviderWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  public async process(
    @Body() body: unknown,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Headers('x-correlation-id') rawCorrelationId: string | undefined,
  ) {
    try {
      const input = wagerRequestSchema.parse(body);
      const idempotencyKey = idempotencyKeySchema.parse(rawIdempotencyKey);
      const correlationId =
        rawCorrelationId === undefined
          ? randomUUID()
          : providerIdentifierSchema.parse(rawCorrelationId);
      const outcome = await this.processWagerTransaction.execute({
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        idempotencyKey,
        correlationId,
        money: Money.create(input.money),
        ...(input.referenceExternalTransactionId === undefined
          ? {}
          : { referenceExternalTransactionId: input.referenceExternalTransactionId }),
      });
      const response = WagerTransactionPresenter.presentOutcome(outcome);
      if (outcome.status === 'REJECTED') {
        throw new HttpException(response, 422);
      }
      if (outcome.status === 'PENDING_REFERENCE') {
        throw new HttpException(response, 202);
      }
      return response;
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('wagering/transactions/:transactionId')
  public async getById(@Param('transactionId') transactionId: string) {
    try {
      const transaction = await this.getWagerTransaction.execute(
        transactionIdSchema.parse(transactionId),
      );
      return WagerTransactionPresenter.presentTransaction(transaction);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  public async getByProviderIdentity(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    try {
      const transaction = await this.getProviderWagerTransaction.execute({
        providerId: providerIdentifierSchema.parse(providerId),
        externalTransactionId: providerIdentifierSchema.parse(externalTransactionId),
      });
      return WagerTransactionPresenter.presentTransaction(transaction);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }
}
