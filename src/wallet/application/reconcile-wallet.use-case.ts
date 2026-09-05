import { randomUUID } from 'node:crypto';

import type { WalletAccountingPosting } from '../../accounting/application/ports/accounting.repository.js';
import type { OperationalLogger } from '../../observability/application/operational-logger.js';
import { NOOP_OPERATIONAL_LOGGER } from '../../observability/application/operational-logger.js';
import type { OperationalMetrics } from '../../observability/application/operational-metrics.js';
import { NOOP_OPERATIONAL_METRICS } from '../../observability/application/operational-metrics.js';
import { createCorrelationContext } from '../../shared/application/correlation-context.js';
import type { TransactionRunner } from '../../shared/application/transaction-runner.js';
import type { WalletLedgerEntryState } from '../domain/wallet-ledger-entry.js';
import { LedgerHashChain } from '../domain/ledger-hash-chain.js';
import type { WalletTransactionContext } from './ports/wallet-transaction-context.js';
import { WalletNotFoundError } from './wallet-errors.js';

export interface WalletReconciliationResult {
  readonly walletId: string;
  readonly currency: string;
  readonly storedBalanceMinor: bigint;
  readonly calculatedBalanceMinor: bigint;
  readonly accountingBalanceMinor: bigint;
  readonly differenceMinor: bigint;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly accountingBalanced: boolean;
  readonly auditChainValid: boolean;
}

export interface ReconcileWalletDependencies {
  readonly logger?: OperationalLogger;
  readonly metrics?: OperationalMetrics;
  readonly generateCorrelationId?: () => string;
}

function reconstructLedger(entries: readonly WalletLedgerEntryState[], currency: string): bigint {
  return entries.reduce((balance, entry) => {
    if (entry.currency !== currency || entry.amountMinor <= 0n) {
      return balance;
    }
    return entry.direction === 'CREDIT' ? balance + entry.amountMinor : balance - entry.amountMinor;
  }, 0n);
}

function assessAccounting(
  postings: readonly WalletAccountingPosting[],
  walletId: string,
  currency: string,
  expectedBalanceMinor: bigint,
  expectedJournalCount: number,
): Readonly<{ accountingBalanceMinor: bigint; balanced: boolean }> {
  const journals = new Map<string, WalletAccountingPosting[]>();
  let playerBalanceMinor = 0n;

  for (const posting of postings) {
    const journal = journals.get(posting.journalId) ?? [];
    journal.push(posting);
    journals.set(posting.journalId, journal);

    if (
      posting.accountKind === 'PLAYER_BALANCE' &&
      posting.accountOwnerId === walletId &&
      posting.currency === currency
    ) {
      playerBalanceMinor +=
        posting.direction === 'CREDIT' ? posting.amountMinor : -posting.amountMinor;
    }
  }

  const journalsBalanced = [...journals.values()].every((journal) => {
    const currencies = new Set(journal.map(({ currency: postingCurrency }) => postingCurrency));
    const walletPostings = journal.filter(
      (posting) =>
        posting.accountKind === 'PLAYER_BALANCE' &&
        posting.accountOwnerId === walletId &&
        posting.currency === currency,
    );
    const debit = journal
      .filter(({ direction }) => direction === 'DEBIT')
      .reduce((total, { amountMinor }) => total + amountMinor, 0n);
    const credit = journal
      .filter(({ direction }) => direction === 'CREDIT')
      .reduce((total, { amountMinor }) => total + amountMinor, 0n);

    return (
      journal.length === 2 &&
      walletPostings.length === 1 &&
      currencies.size === 1 &&
      journal.every(({ currency: postingCurrency }) => postingCurrency === currency) &&
      debit === credit
    );
  });

  return Object.freeze({
    accountingBalanceMinor: playerBalanceMinor,
    balanced:
      journals.size === expectedJournalCount &&
      journalsBalanced &&
      playerBalanceMinor === expectedBalanceMinor,
  });
}

export class ReconcileWalletUseCase {
  readonly #logger: OperationalLogger;
  readonly #metrics: OperationalMetrics;
  readonly #generateCorrelationId: () => string;

  public constructor(
    private readonly transactionRunner: TransactionRunner<WalletTransactionContext>,
    dependencies: ReconcileWalletDependencies = {},
  ) {
    this.#logger = dependencies.logger ?? NOOP_OPERATIONAL_LOGGER;
    this.#metrics = dependencies.metrics ?? NOOP_OPERATIONAL_METRICS;
    this.#generateCorrelationId = dependencies.generateCorrelationId ?? randomUUID;
  }

  public async execute(
    walletId: string,
    correlationId = this.#generateCorrelationId(),
  ): Promise<WalletReconciliationResult> {
    const result = await this.transactionRunner.run(async ({ accounting, wallets }) => {
      const wallet = await wallets.lockById(walletId);
      if (wallet === null) {
        throw new WalletNotFoundError();
      }

      const [entries, postings] = await Promise.all([
        wallets.listLedgerStates(walletId),
        accounting.listWalletPostings(walletId),
      ]);
      const calculatedBalanceMinor = reconstructLedger(entries, wallet.currency);
      const auditChainValid =
        LedgerHashChain.verify(entries, wallet.currency) &&
        wallet.ledgerSequence === BigInt(entries.length) &&
        wallet.lastLedgerHash === (entries.at(-1)?.entryHash ?? null);
      const accountingAssessment = assessAccounting(
        postings,
        walletId,
        wallet.currency,
        calculatedBalanceMinor,
        entries.length,
      );

      return Object.freeze({
        walletId,
        currency: wallet.currency,
        storedBalanceMinor: wallet.balance.amountMinor,
        calculatedBalanceMinor,
        accountingBalanceMinor: accountingAssessment.accountingBalanceMinor,
        differenceMinor: wallet.balance.amountMinor - calculatedBalanceMinor,
        consistent:
          wallet.balance.amountMinor === calculatedBalanceMinor &&
          accountingAssessment.balanced &&
          auditChainValid,
        checkedEntries: entries.length,
        accountingBalanced: accountingAssessment.balanced,
        auditChainValid,
      });
    });

    if (!result.consistent) {
      try {
        this.#metrics.recordReconciliationDivergence();
      } catch {
        // Reconciliation evidence must remain available when telemetry fails.
      }
      try {
        this.#logger.info(
          'reconciliation_diverged',
          createCorrelationContext({ correlationId, walletId }),
          {
            checkedEntries: result.checkedEntries,
            accountingBalanced: result.accountingBalanced,
            auditChainValid: result.auditChainValid,
          },
        );
      } catch {
        // Reconciliation evidence must remain available when telemetry fails.
      }
    }

    return result;
  }
}
