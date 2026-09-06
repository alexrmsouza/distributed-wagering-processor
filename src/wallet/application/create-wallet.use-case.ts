import { randomUUID } from 'node:crypto';

import { Account, AccountKind } from '../../accounting/domain/account.js';
import { AccountingJournal } from '../../accounting/domain/accounting-journal.js';
import { AccountingPosting } from '../../accounting/domain/accounting-posting.js';
import { OutboxMessage } from '../../messaging/domain/outbox-message.js';
import { SystemClock, type Clock } from '../../shared/application/clock.js';
import type { TransactionRunner } from '../../shared/application/transaction-runner.js';
import type { FailpointPort } from '../../shared/application/failpoints/failpoint.port.js';
import { Money } from '../../shared/domain/money.js';
import { hashPayload } from '../../shared/domain/payload-hash.js';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { Wallet } from '../domain/wallet.js';
import type { WalletTransactionContext } from './ports/wallet-transaction-context.js';
import { WalletOpenedEvent } from '../../messaging/application/events/wallet-opened.event.js';
import { WalletAlreadyExistsError } from './wallet-errors.js';

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface CreateWalletDependencies {
  readonly clock?: Clock;
  readonly generateId?: () => string;
  readonly failpoints?: FailpointPort;
}

const NOOP_FAILPOINTS: FailpointPort = {
  trigger: () => Promise.resolve(),
};

export class CreateWalletUseCase {
  readonly #clock: Clock;
  readonly #generateId: () => string;
  readonly #failpoints: FailpointPort;

  public constructor(
    private readonly transactionRunner: TransactionRunner<WalletTransactionContext>,
    dependencies: CreateWalletDependencies = {},
  ) {
    this.#clock = dependencies.clock ?? new SystemClock();
    this.#generateId = dependencies.generateId ?? randomUUID;
    this.#failpoints = dependencies.failpoints ?? NOOP_FAILPOINTS;
  }

  public execute(command: CreateWalletCommand): Promise<Wallet> {
    const occurredAt = this.#clock.now();
    const walletId = this.#generateId();
    const correlationId = command.correlationId ?? this.#generateId();

    return this.transactionRunner.run(async (context) => {
      if (
        (await context.wallets.findByPlayerAndCurrency(
          command.playerId,
          command.initialBalance.currency,
        )) !== null
      ) {
        throw new WalletAlreadyExistsError();
      }

      let wallet = Wallet.create({
        id: walletId,
        playerId: command.playerId,
        openingBalance: command.initialBalance,
        createdAt: occurredAt,
      });
      let openingTransactionId: string | null = null;
      let openingEntry: WalletLedgerEntry | null = null;

      if (command.initialBalance.amountMinor > 0n) {
        openingTransactionId = this.#generateId();
        openingEntry = WalletLedgerEntry.create({
          id: this.#generateId(),
          walletId,
          transactionId: openingTransactionId,
          entrySequence: 1n,
          direction: 'CREDIT',
          amount: command.initialBalance,
          balanceBefore: Money.create({
            amount: '0.00',
            currency: command.initialBalance.currency,
          }),
          previousEntryHash: null,
          createdAt: occurredAt,
        });
        wallet = wallet.withLedgerHead(openingEntry.entrySequence, openingEntry.entryHash);
      }

      await context.wallets.insert(wallet);

      if (openingTransactionId !== null && openingEntry !== null) {
        const fundingAccount = await context.accounting.getOrCreateAccount(
          Account.create({
            id: this.#generateId(),
            kind: AccountKind.InternalFunding,
            ownerId: 'internal',
            currency: command.initialBalance.currency,
            createdAt: occurredAt,
          }),
        );
        const playerAccount = await context.accounting.getOrCreateAccount(
          Account.create({
            id: this.#generateId(),
            kind: AccountKind.PlayerBalance,
            ownerId: walletId,
            currency: command.initialBalance.currency,
            createdAt: occurredAt,
          }),
        );
        const journalId = this.#generateId();
        const openingJournal = AccountingJournal.create({
          id: journalId,
          transactionId: openingTransactionId,
          walletId,
          createdAt: occurredAt,
          postings: [
            AccountingPosting.create({
              id: this.#generateId(),
              journalId,
              accountId: fundingAccount.id,
              direction: 'DEBIT',
              amount: command.initialBalance,
              createdAt: occurredAt,
            }),
            AccountingPosting.create({
              id: this.#generateId(),
              journalId,
              accountId: playerAccount.id,
              direction: 'CREDIT',
              amount: command.initialBalance,
              createdAt: occurredAt,
            }),
          ],
        });
        const identity = `wallet-opening:${walletId}`;
        await context.openingTransactions.insertOpening({
          id: openingTransactionId,
          externalTransactionId: identity,
          idempotencyKey: identity,
          payloadHash: hashPayload({
            operation: 'OPENING',
            walletId,
            playerId: command.playerId,
            amountMinor: command.initialBalance.amountMinor.toString(),
            currency: command.initialBalance.currency,
          }),
          walletId,
          playerId: command.playerId,
          amountMinor: command.initialBalance.amountMinor,
          currency: command.initialBalance.currency,
          observedBalanceMinor: command.initialBalance.amountMinor,
          occurredAt,
        });
        await context.wallets.appendLedgerEntry(openingEntry);
        await context.accounting.insertJournal(openingJournal);
      }

      const event = WalletOpenedEvent.from({
        eventId: this.#generateId(),
        walletId,
        playerId: command.playerId,
        initialBalance: command.initialBalance.toJSON(),
        correlationId,
        ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
        occurredAt,
      });
      await context.outbox.insert(
        OutboxMessage.enqueue({
          id: this.#generateId(),
          event,
        }),
      );

      await this.#failpoints.trigger('before_financial_commit');
      return wallet;
    });
  }
}
