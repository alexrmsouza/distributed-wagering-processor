import { randomUUID } from 'node:crypto';

import { Account, AccountKind } from '../../accounting/domain/account.js';
import type { OperationalLogger } from '../../observability/application/operational-logger.js';
import { NOOP_OPERATIONAL_LOGGER } from '../../observability/application/operational-logger.js';
import type { OperationalMetrics } from '../../observability/application/operational-metrics.js';
import { NOOP_OPERATIONAL_METRICS } from '../../observability/application/operational-metrics.js';
import { SystemClock, type Clock } from '../../shared/application/clock.js';
import { createCorrelationContext } from '../../shared/application/correlation-context.js';
import type { TransactionRunner } from '../../shared/application/transaction-runner.js';
import { Money } from '../../shared/domain/money.js';
import { hashPayload } from '../../shared/domain/payload-hash.js';
import type { FailpointPort } from '../../shared/infrastructure/failpoints/failpoint.port.js';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.js';
import type { Wallet } from '../../wallet/domain/wallet.js';
import { FAILURE_CODES, type FailureCode } from '../domain/failure-code.js';
import { validateReversal, type ReversalDirection } from '../domain/reversal-rules.js';
import { WagerTransaction } from '../domain/wager-transaction.js';
import { PendingReferencePolicy } from './pending-reference-policy.js';
import type { PendingReferenceContext } from './ports/pending-reference.repository.js';
import type { WageringTransactionContext } from './ports/wagering-transaction-context.js';
import {
  assertValidWagerCommand,
  createWagerBusinessPayload,
  deterministicWagerResultId,
} from './wager-command-identity.js';
import { createWagerAccountingJournal } from './wager-accounting-journal.factory.js';
import {
  createBalanceChangedOutboxMessage,
  createPendingReferenceOutboxMessage,
  createProcessedOutboxMessage,
  createRejectedOutboxMessage,
} from './wager-outbox-message.factory.js';
import { IdempotencyConflictError } from './wagering-errors.js';

export type ProcessableWagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export interface ProcessWagerTransactionCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: ProcessableWagerKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface ProcessWagerTransactionResult {
  readonly transactionId: string;
  readonly status: 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
  readonly balance: Money;
  readonly idempotentReplay: boolean;
  readonly failureCode?: FailureCode;
}

export interface ProcessWagerTransactionDependencies {
  readonly clock?: Clock;
  readonly generateId?: () => string;
  readonly failpoints?: FailpointPort;
  readonly logger?: OperationalLogger;
  readonly metrics?: OperationalMetrics;
}

const NOOP_FAILPOINTS: FailpointPort = Object.freeze({
  trigger: () => Promise.resolve(),
});

export class ProcessWagerTransactionUseCase {
  readonly #clock: Clock;
  readonly #generateId: () => string;
  readonly #failpoints: FailpointPort;
  readonly #logger: OperationalLogger;
  readonly #metrics: OperationalMetrics;

  public constructor(
    private readonly transactionRunner: TransactionRunner<WageringTransactionContext>,
    dependencies: ProcessWagerTransactionDependencies = {},
  ) {
    this.#clock = dependencies.clock ?? new SystemClock();
    this.#generateId = dependencies.generateId ?? randomUUID;
    this.#failpoints = dependencies.failpoints ?? NOOP_FAILPOINTS;
    this.#logger = dependencies.logger ?? NOOP_OPERATIONAL_LOGGER;
    this.#metrics = dependencies.metrics ?? NOOP_OPERATIONAL_METRICS;
  }

  public async execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const startedAt = performance.now();
    this.safeLog('received', command, undefined, { transport: 'http' });
    const result = await this.transactionRunner.run((context) =>
      this.executeInContext(context, command),
    );
    this.safeLog('transaction_committed', command, result.transactionId, {
      status: result.status,
    });
    this.observeCommittedResult(result, command.kind, 'http', startedAt);
    return result;
  }

  public async executeInContext(
    context: WageringTransactionContext,
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    assertValidWagerCommand(command);
    const occurredAt = this.#clock.now();
    const transactionId = this.#generateId();
    const payloadHash = hashPayload(createWagerBusinessPayload(command));

    const observedWallet = await context.wallets.findById(command.walletId);
    if (observedWallet === null) {
      return this.missingWalletResult(command, deterministicWagerResultId(payloadHash));
    }

    const existingByIdempotency = await context.wagerTransactions.findByIdempotencyKey(
      command.providerId,
      command.idempotencyKey,
    );
    const existing =
      existingByIdempotency ??
      (await context.wagerTransactions.findByProviderAndExternalId(
        command.providerId,
        command.externalTransactionId,
      ));
    if (existing !== null) {
      this.assertAndLogReplayIdentity(existing, command, payloadHash);
      if (existing.status === 'PENDING_REFERENCE') {
        return this.resumePendingFromHttp(context, existing, observedWallet, command, occurredAt);
      }
      return this.toTerminalResult(existing, true);
    }

    const candidate = WagerTransaction.create({
      id: transactionId,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      amount: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
      referenceTransactionId: null,
      createdAt: occurredAt,
    });
    this.logIdempotencyDecision(command, transactionId, 'new');

    if (command.kind === 'REFUND' || command.kind === 'ROLLBACK') {
      return this.processNewReversal(context, candidate, observedWallet, command, occurredAt);
    }

    const canMutateWallet =
      command.kind !== 'LOSS' &&
      observedWallet.playerId === command.playerId &&
      observedWallet.currency === command.money.currency;
    const wallet = canMutateWallet
      ? await context.wallets.lockById(command.walletId)
      : observedWallet;
    if (canMutateWallet) {
      this.safeLog('wallet_lock', command, transactionId, {
        outcome: wallet === null ? 'not_found' : 'acquired',
      });
    }

    if (!(await context.wagerTransactions.insert(candidate))) {
      return this.replayOrConflict(context, command, payloadHash);
    }

    if (wallet?.playerId !== command.playerId) {
      return this.reject(
        context,
        candidate,
        observedWallet,
        FAILURE_CODES.WALLET_NOT_FOUND,
        command,
        occurredAt,
      );
    }
    if (wallet.currency !== command.money.currency) {
      return this.reject(
        context,
        candidate,
        wallet,
        FAILURE_CODES.CURRENCY_MISMATCH,
        command,
        occurredAt,
      );
    }

    if (command.kind === 'LOSS') {
      const processed = candidate.process({
        observedBalance: wallet.balance,
        processedAt: occurredAt,
      });
      await context.wagerTransactions.save(processed);
      await this.enqueueProcessed(context, processed, command, occurredAt);
      this.logOutboxPersisted(command, processed.id);
      await this.#failpoints.trigger('before_financial_commit');
      return this.toTerminalResult(processed, false);
    }

    if (command.kind === 'BET' && wallet.balance.compareTo(command.money) < 0) {
      return this.reject(
        context,
        candidate,
        wallet,
        FAILURE_CODES.INSUFFICIENT_FUNDS,
        command,
        occurredAt,
      );
    }

    return this.applyFinancialMovement(context, candidate, wallet, command, occurredAt);
  }

  public async replayResultInContext(
    context: WageringTransactionContext,
    transactionId: string,
  ): Promise<ProcessWagerTransactionResult | null> {
    const transaction = await context.wagerTransactions.findById(transactionId);
    if (transaction === null || transaction.status === 'PENDING') {
      return null;
    }
    if (transaction.status === 'PENDING_REFERENCE') {
      const wallet = await context.wallets.findById(transaction.walletId);
      return wallet === null ? null : this.pendingResult(transaction, wallet, true);
    }
    return this.toTerminalResult(transaction, true);
  }

  public retryPendingReference(
    transactionId: string,
    leaseToken: string,
  ): Promise<ProcessWagerTransactionResult | null> {
    const occurredAt = this.#clock.now();

    return this.transactionRunner.run(async (context) => {
      const observed = await context.wagerTransactions.findById(transactionId);
      if (observed?.status !== 'PENDING_REFERENCE') {
        return null;
      }
      const wallet = await context.wallets.findById(observed.walletId);
      if (wallet === null) {
        return null;
      }
      const retryExpiresAt = observed.retryExpiresAt;
      const nextRetryAt = observed.nextRetryAt;
      if (retryExpiresAt === null || nextRetryAt === null) {
        throw new Error('Pending reference does not contain its persisted retry schedule');
      }

      if (occurredAt.getTime() >= retryExpiresAt.getTime()) {
        const pendingContext = await context.pendingReferences.lockLeased(
          observed.id,
          leaseToken,
          occurredAt,
        );
        if (pendingContext === null) {
          return null;
        }
        return this.reject(
          context,
          pendingContext.transaction,
          wallet,
          FAILURE_CODES.REFERENCE_NOT_FOUND,
          this.commandFromPending(pendingContext),
          occurredAt,
        );
      }

      const reference = await context.wagerTransactions.findByProviderAndExternalId(
        observed.providerId,
        this.requiredReference(observed),
      );
      if (reference === null) {
        const foreignReference = await context.wagerTransactions.findByExternalId(
          this.requiredReference(observed),
        );
        const pendingContext = await context.pendingReferences.lockLeased(
          observed.id,
          leaseToken,
          occurredAt,
        );
        if (pendingContext === null) {
          return null;
        }
        if (foreignReference !== null) {
          return this.reject(
            context,
            pendingContext.transaction,
            wallet,
            FAILURE_CODES.INVALID_REFERENCE,
            this.commandFromPending(pendingContext),
            occurredAt,
          );
        }
        const policy = new PendingReferencePolicy(this.#clock);
        const decision = policy.afterMissingReference({
          retryAttempts: pendingContext.transaction.retryAttempts,
          nextRetryAt,
          retryExpiresAt,
        });
        if (decision.kind === 'EXPIRED') {
          return this.reject(
            context,
            pendingContext.transaction,
            wallet,
            FAILURE_CODES.REFERENCE_NOT_FOUND,
            this.commandFromPending(pendingContext),
            occurredAt,
          );
        }
        const rescheduled = pendingContext.transaction.reschedulePendingReference({
          ...decision,
          updatedAt: occurredAt,
        });
        await context.pendingReferences.reschedule(rescheduled, leaseToken, decision, occurredAt);
        return this.pendingResult(rescheduled, wallet, false);
      }

      const preliminary = validateReversal({
        transaction: observed,
        reference,
        duplicateExists: false,
      });
      if (!preliminary.valid) {
        const pendingContext = await context.pendingReferences.lockLeased(
          observed.id,
          leaseToken,
          occurredAt,
        );
        if (pendingContext === null) {
          return null;
        }
        return this.reject(
          context,
          pendingContext.transaction,
          wallet,
          preliminary.failureCode,
          this.commandFromPending(pendingContext),
          occurredAt,
        );
      }

      const lockedWallet = await context.wallets.lockById(observed.walletId);
      const lockedReference = await context.wagerTransactions.findById(reference.id, true);
      const pendingContext = await context.pendingReferences.lockLeased(
        observed.id,
        leaseToken,
        occurredAt,
      );
      if (lockedWallet === null || lockedReference === null || pendingContext === null) {
        return null;
      }
      this.safeLog('wallet_lock', this.commandFromPending(pendingContext), observed.id, {
        outcome: 'acquired',
      });
      return this.processResolvedReversal(
        context,
        pendingContext,
        lockedReference,
        lockedWallet,
        occurredAt,
      );
    });
  }

  private missingWalletResult(
    command: ProcessWagerTransactionCommand,
    transactionId: string,
  ): ProcessWagerTransactionResult {
    return Object.freeze({
      transactionId,
      status: 'REJECTED',
      balance: Money.rehydrate({ amountMinor: 0n, currency: command.money.currency }),
      idempotentReplay: false,
      failureCode: FAILURE_CODES.WALLET_NOT_FOUND,
    });
  }

  private async processNewReversal(
    context: WageringTransactionContext,
    candidate: WagerTransaction,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const referenceExternalTransactionId = this.requiredReference(candidate);
    if (candidate.externalTransactionId === referenceExternalTransactionId) {
      if (!(await context.wagerTransactions.insert(candidate))) {
        return this.replayOrConflict(context, command, candidate.payloadHash);
      }
      return this.reject(
        context,
        candidate,
        wallet,
        FAILURE_CODES.INVALID_REFERENCE,
        command,
        occurredAt,
      );
    }
    const reference = await context.wagerTransactions.findByProviderAndExternalId(
      candidate.providerId,
      referenceExternalTransactionId,
    );

    if (reference === null) {
      const foreignReference = await context.wagerTransactions.findByExternalId(
        referenceExternalTransactionId,
      );
      if (!(await context.wagerTransactions.insert(candidate))) {
        return this.replayOrConflict(context, command, candidate.payloadHash);
      }
      if (foreignReference !== null) {
        return this.reject(
          context,
          candidate,
          wallet,
          FAILURE_CODES.INVALID_REFERENCE,
          command,
          occurredAt,
        );
      }
      return this.initializePendingReference(context, candidate, wallet, command, occurredAt);
    }

    const preliminary = validateReversal({
      transaction: candidate,
      reference,
      duplicateExists: false,
    });
    if (!preliminary.valid) {
      if (!(await context.wagerTransactions.insert(candidate))) {
        return this.replayOrConflict(context, command, candidate.payloadHash);
      }
      return this.reject(context, candidate, wallet, preliminary.failureCode, command, occurredAt);
    }

    const lockedWallet = await context.wallets.lockById(candidate.walletId);
    this.safeLog('wallet_lock', command, candidate.id, {
      outcome: lockedWallet === null ? 'not_found' : 'acquired',
    });
    const lockedReference = await context.wagerTransactions.findById(reference.id, true);
    if (lockedWallet === null || lockedReference === null) {
      throw new Error('Reversal lock target disappeared inside the transaction');
    }
    if (!(await context.wagerTransactions.insert(candidate))) {
      return this.replayOrConflict(context, command, candidate.payloadHash);
    }

    return this.processResolvedReversal(
      context,
      Object.freeze({
        transaction: candidate,
        correlationId: command.correlationId,
        causationId: command.causationId ?? null,
      }),
      lockedReference,
      lockedWallet,
      occurredAt,
    );
  }

  private async resumePendingFromHttp(
    context: WageringTransactionContext,
    pending: WagerTransaction,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const referenceExternalTransactionId = this.requiredReference(pending);
    const retryExpiresAt = pending.retryExpiresAt;
    if (retryExpiresAt === null) {
      throw new Error('Pending reference does not contain its persisted retry expiration');
    }
    if (occurredAt.getTime() >= retryExpiresAt.getTime()) {
      const lockedPending = await context.pendingReferences.lockPending(pending.id);
      if (lockedPending === null) {
        const completed = await context.wagerTransactions.findById(pending.id);
        if (completed !== null && completed.status !== 'PENDING_REFERENCE') {
          return this.toTerminalResult(completed, true);
        }
        throw new Error('Pending reference changed while its expiration was being resolved');
      }
      return this.reject(
        context,
        lockedPending.transaction,
        wallet,
        FAILURE_CODES.REFERENCE_NOT_FOUND,
        this.commandFromPending(lockedPending),
        occurredAt,
      );
    }
    const reference = await context.wagerTransactions.findByProviderAndExternalId(
      pending.providerId,
      referenceExternalTransactionId,
    );
    if (reference === null) {
      const foreignReference = await context.wagerTransactions.findByExternalId(
        referenceExternalTransactionId,
      );
      if (foreignReference === null) {
        return this.pendingResult(pending, wallet, true);
      }
      const lockedPending = await context.pendingReferences.lockPending(pending.id);
      if (lockedPending === null) {
        throw new Error('Pending reference changed while it was being resumed');
      }
      return this.reject(
        context,
        lockedPending.transaction,
        wallet,
        FAILURE_CODES.INVALID_REFERENCE,
        this.commandFromPending(lockedPending),
        occurredAt,
      );
    }

    const preliminary = validateReversal({
      transaction: pending,
      reference,
      duplicateExists: false,
    });
    if (!preliminary.valid) {
      const lockedPending = await context.pendingReferences.lockPending(pending.id);
      if (lockedPending === null) {
        throw new Error('Pending reference changed while it was being rejected');
      }
      return this.reject(
        context,
        lockedPending.transaction,
        wallet,
        preliminary.failureCode,
        this.commandFromPending(lockedPending),
        occurredAt,
      );
    }

    const lockedWallet = await context.wallets.lockById(pending.walletId);
    this.safeLog('wallet_lock', command, pending.id, {
      outcome: lockedWallet === null ? 'not_found' : 'acquired',
    });
    const lockedReference = await context.wagerTransactions.findById(reference.id, true);
    const lockedPending = await context.pendingReferences.lockPending(pending.id);
    if (lockedPending === null) {
      const completed = await context.wagerTransactions.findById(pending.id);
      if (completed !== null && completed.status !== 'PENDING_REFERENCE') {
        return this.toTerminalResult(completed, true);
      }
    }
    if (lockedWallet === null || lockedReference === null || lockedPending === null) {
      throw new Error('Pending reversal lock target disappeared inside the transaction');
    }
    this.assertReplayIdentity(lockedPending.transaction, command, pending.payloadHash);

    return this.processResolvedReversal(
      context,
      lockedPending,
      lockedReference,
      lockedWallet,
      occurredAt,
    );
  }

  private async processResolvedReversal(
    context: WageringTransactionContext,
    pendingContext: PendingReferenceContext,
    reference: WagerTransaction,
    wallet: Wallet,
    occurredAt: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const pending = pendingContext.transaction;
    const duplicate = await context.wagerTransactions.findReversalByReference(
      reference.id,
      pending.kind as 'REFUND' | 'ROLLBACK',
      pending.id,
    );
    const validation = validateReversal({
      transaction: pending,
      reference,
      duplicateExists: duplicate !== null,
    });
    const command = this.commandFromPending(pendingContext);
    if (!validation.valid) {
      return this.reject(context, pending, wallet, validation.failureCode, command, occurredAt);
    }

    const resolved = pending.resolveReference({
      referenceTransactionId: validation.referenceTransactionId,
      updatedAt: occurredAt,
    });
    if (validation.direction === 'DEBIT' && wallet.balance.compareTo(validation.amount) < 0) {
      return this.reject(
        context,
        resolved,
        wallet,
        FAILURE_CODES.REVERSAL_WOULD_OVERDRAW,
        command,
        occurredAt,
      );
    }

    return this.applyMovement(context, resolved, wallet, command, occurredAt, validation.direction);
  }

  private async initializePendingReference(
    context: WageringTransactionContext,
    candidate: WagerTransaction,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const schedule = new PendingReferencePolicy(this.#clock).accept();
    const pending = candidate.markPendingReference({ ...schedule, updatedAt: occurredAt });
    await context.pendingReferences.initialize(
      candidate,
      schedule,
      command.correlationId,
      command.causationId ?? null,
      occurredAt,
    );
    await context.outbox.insert(
      createPendingReferenceOutboxMessage({
        outboxMessageId: this.#generateId(),
        eventId: this.#generateId(),
        transaction: pending,
        referenceExternalTransactionId: this.requiredReference(pending),
        retryExpiresAt: schedule.retryExpiresAt,
        command,
        occurredAt,
      }),
    );
    this.logOutboxPersisted(command, pending.id);
    await this.#failpoints.trigger('before_financial_commit');
    return this.pendingResult(pending, wallet, false);
  }

  private pendingResult(
    transaction: WagerTransaction,
    wallet: Wallet,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionResult {
    return Object.freeze({
      transactionId: transaction.id,
      status: 'PENDING_REFERENCE',
      balance: wallet.balance,
      idempotentReplay,
    });
  }

  private commandFromPending(context: PendingReferenceContext): ProcessWagerTransactionCommand {
    const transaction = context.transaction;
    if (transaction.kind !== 'REFUND' && transaction.kind !== 'ROLLBACK') {
      throw new Error('Pending reference transaction is not a reversal');
    }
    return Object.freeze({
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.amount,
      referenceExternalTransactionId: this.requiredReference(transaction),
      correlationId: context.correlationId,
      ...(context.causationId === null ? {} : { causationId: context.causationId }),
    });
  }

  private requiredReference(transaction: WagerTransaction): string {
    if (transaction.referenceExternalTransactionId === null) {
      throw new Error('Reversal transaction does not contain its external reference');
    }
    return transaction.referenceExternalTransactionId;
  }

  private async replayOrConflict(
    context: WageringTransactionContext,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const byIdempotency = await context.wagerTransactions.findByIdempotencyKey(
      command.providerId,
      command.idempotencyKey,
      true,
    );
    const existing =
      byIdempotency ??
      (await context.wagerTransactions.findByProviderAndExternalId(
        command.providerId,
        command.externalTransactionId,
        true,
      ));

    if (existing === null) {
      this.logIdempotencyDecision(command, undefined, 'conflict');
      throw new IdempotencyConflictError();
    }

    this.assertAndLogReplayIdentity(existing, command, payloadHash);
    if (existing.status === 'PENDING_REFERENCE') {
      const wallet = await context.wallets.findById(existing.walletId);
      if (wallet === null) {
        throw new Error('Pending reference wallet no longer exists');
      }
      return this.pendingResult(existing, wallet, true);
    }
    return this.toTerminalResult(existing, true);
  }

  private assertReplayIdentity(
    existing: WagerTransaction,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): void {
    if (
      existing.idempotencyKey !== command.idempotencyKey ||
      existing.externalTransactionId !== command.externalTransactionId ||
      existing.payloadHash !== payloadHash
    ) {
      throw new IdempotencyConflictError();
    }
    if (existing.status === 'PENDING') {
      throw new Error('An idempotent replay does not have a committed terminal outcome');
    }
  }

  private assertAndLogReplayIdentity(
    existing: WagerTransaction,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): void {
    try {
      this.assertReplayIdentity(existing, command, payloadHash);
      this.logIdempotencyDecision(command, existing.id, 'replay');
    } catch (error: unknown) {
      if (error instanceof IdempotencyConflictError) {
        this.logIdempotencyDecision(command, existing.id, 'conflict');
      }
      throw error;
    }
  }

  private async reject(
    context: WageringTransactionContext,
    pending: WagerTransaction,
    wallet: Wallet,
    failureCode: FailureCode,
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const rejected = pending.reject({
      failureCode,
      observedBalance: wallet.balance,
      processedAt: occurredAt,
    });
    await context.wagerTransactions.save(rejected);
    await context.outbox.insert(
      createRejectedOutboxMessage({
        outboxMessageId: this.#generateId(),
        eventId: this.#generateId(),
        transaction: rejected,
        failureCode,
        balance: wallet.balance,
        command,
        occurredAt,
      }),
    );
    this.logOutboxPersisted(command, rejected.id);
    await this.#failpoints.trigger('before_financial_commit');
    return this.toTerminalResult(rejected, false);
  }

  private async applyFinancialMovement(
    context: WageringTransactionContext,
    pending: WagerTransaction,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const direction = command.kind === 'BET' ? 'DEBIT' : 'CREDIT';
    return this.applyMovement(context, pending, wallet, command, occurredAt, direction);
  }

  private async applyMovement(
    context: WageringTransactionContext,
    pending: WagerTransaction,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
    direction: ReversalDirection,
  ): Promise<ProcessWagerTransactionResult> {
    const ledgerEntry = WalletLedgerEntry.create({
      id: this.#generateId(),
      walletId: wallet.id,
      transactionId: pending.id,
      entrySequence: wallet.ledgerSequence + 1n,
      direction,
      amount: command.money,
      balanceBefore: wallet.balance,
      previousEntryHash: wallet.lastLedgerHash,
      createdAt: occurredAt,
    });
    const changedWallet = (
      direction === 'DEBIT'
        ? wallet.debit(command.money, occurredAt)
        : wallet.credit(command.money, occurredAt)
    ).withLedgerHead(ledgerEntry.entrySequence, ledgerEntry.entryHash);
    const processed = pending.process({
      observedBalance: changedWallet.balance,
      processedAt: occurredAt,
    });
    const playerAccount = await context.accounting.getOrCreateAccount(
      Account.create({
        id: this.#generateId(),
        kind: AccountKind.PlayerBalance,
        ownerId: wallet.id,
        currency: wallet.currency,
        createdAt: occurredAt,
      }),
    );
    const clearingAccount = await context.accounting.getOrCreateAccount(
      Account.create({
        id: this.#generateId(),
        kind: AccountKind.ProviderClearing,
        ownerId: command.providerId,
        currency: wallet.currency,
        createdAt: occurredAt,
      }),
    );
    const journalId = this.#generateId();
    const journal = createWagerAccountingJournal({
      journalId,
      debitPostingId: this.#generateId(),
      creditPostingId: this.#generateId(),
      transactionId: processed.id,
      walletId: wallet.id,
      playerAccountId: playerAccount.id,
      clearingAccountId: clearingAccount.id,
      direction,
      amount: command.money,
      occurredAt,
    });

    await context.wagerTransactions.save(processed);
    await context.wallets.appendLedgerEntry(ledgerEntry);
    await context.accounting.insertJournal(journal);
    await context.wallets.save(changedWallet);
    await this.enqueueProcessed(context, processed, command, occurredAt);
    await context.outbox.insert(
      createBalanceChangedOutboxMessage({
        outboxMessageId: this.#generateId(),
        eventId: this.#generateId(),
        transaction: processed,
        direction,
        previousWallet: wallet,
        changedWallet,
        command,
        occurredAt,
      }),
    );
    this.logOutboxPersisted(command, processed.id);
    await this.#failpoints.trigger('before_financial_commit');
    return this.toTerminalResult(processed, false);
  }

  private async enqueueProcessed(
    context: WageringTransactionContext,
    transaction: WagerTransaction,
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
  ): Promise<void> {
    await context.outbox.insert(
      createProcessedOutboxMessage({
        outboxMessageId: this.#generateId(),
        eventId: this.#generateId(),
        transaction,
        command,
        occurredAt,
      }),
    );
  }

  private toTerminalResult(
    transaction: WagerTransaction,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionResult {
    if (transaction.observedBalance === null || transaction.status === 'PENDING_REFERENCE') {
      throw new Error('Wager transaction does not contain a terminal outcome');
    }
    if (transaction.status === 'PENDING') {
      throw new Error('Wager transaction is still pending');
    }

    return Object.freeze({
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.observedBalance,
      idempotentReplay,
      ...(transaction.failureCode === null ? {} : { failureCode: transaction.failureCode }),
    });
  }

  private observeCommittedResult(
    result: ProcessWagerTransactionResult,
    kind: ProcessableWagerKind,
    transport: 'http' | 'sqs',
    startedAt: number,
  ): void {
    try {
      this.#metrics.observeProcessingDuration((performance.now() - startedAt) / 1_000, transport);
      this.#metrics.recordTransaction(result.status, kind, transport);
      if (result.idempotentReplay) {
        this.#metrics.recordDuplicate(transport === 'sqs' ? 'sqs_command' : 'http');
      }
    } catch {
      // Telemetry must not change a committed business outcome.
    }
  }

  private logIdempotencyDecision(
    command: ProcessWagerTransactionCommand,
    transactionId: string | undefined,
    decision: 'conflict' | 'new' | 'replay',
  ): void {
    this.safeLog('idempotency_decision', command, transactionId, { decision });
  }

  private logOutboxPersisted(command: ProcessWagerTransactionCommand, transactionId: string): void {
    this.safeLog('outbox_persisted', command, transactionId, { outcome: 'persisted' });
  }

  private safeLog(
    event:
      | 'received'
      | 'idempotency_decision'
      | 'wallet_lock'
      | 'outbox_persisted'
      | 'transaction_committed',
    command: ProcessWagerTransactionCommand,
    transactionId: string | undefined,
    attributes: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.#logger.info(
        event,
        createCorrelationContext({
          correlationId: command.correlationId,
          ...(transactionId === undefined ? {} : { transactionId }),
          walletId: command.walletId,
          providerId: command.providerId,
          ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
        }),
        attributes,
      );
    } catch {
      // Diagnostics must not change a financial outcome.
    }
  }
}
