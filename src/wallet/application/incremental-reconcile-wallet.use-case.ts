import type { AccountingRepository } from '../../accounting/application/ports/accounting.repository.js';
import { SystemClock, type Clock } from '../../shared/application/clock.js';
import type { TransactionRunner } from '../../shared/application/transaction-runner.js';
import { LedgerHashChain } from '../domain/ledger-hash-chain.js';
import type { WalletLedgerEntryState } from '../domain/wallet-ledger-entry.js';
import type { Wallet } from '../domain/wallet.js';
import type { ReconciliationCheckpointRepository } from './ports/reconciliation-checkpoint.repository.js';
import type { WalletRepository } from './ports/wallet.repository.js';
import {
  assessAccounting,
  reconstructLedger,
  type WalletReconciliationResult,
} from './reconcile-wallet.use-case.js';
import { WalletNotFoundError } from './wallet-errors.js';

export type ReconciliationCheckpointStatus =
  'ADVANCED' | 'CREATED' | 'INVALIDATED' | 'REBUILT' | 'UNCHANGED';

export interface IncrementalWalletReconciliationResult extends WalletReconciliationResult {
  readonly checkpointStatus: ReconciliationCheckpointStatus;
  readonly entriesScanned: number;
}

export interface IncrementalReconciliationTransactionContext {
  readonly wallets: Pick<WalletRepository, 'lockById' | 'transactionBound'>;
  readonly accounting: Pick<AccountingRepository, 'listWalletPostings' | 'transactionBound'>;
  readonly reconciliationCheckpoints: ReconciliationCheckpointRepository;
}

interface IncrementalReconciliationDependencies {
  readonly clock?: Clock;
}

interface LedgerAssessment {
  readonly calculatedBalanceMinor: bigint;
  readonly auditChainValid: boolean;
  readonly entriesScanned: number;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function safeEntryCount(sequence: bigint): number {
  const count = Number(sequence);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('Wallet ledger sequence exceeds the supported reconciliation range');
  }
  return count;
}

function assessLedgerSuffix(
  entries: readonly WalletLedgerEntryState[],
  wallet: Wallet,
  sequence: bigint,
  previousHash: string | null,
  startingBalanceMinor: bigint,
): LedgerAssessment {
  let expectedSequence = sequence;
  let expectedPreviousHash = previousHash;
  let balance = startingBalanceMinor;
  let valid = true;

  for (const entry of entries) {
    expectedSequence += 1n;
    const expectedAfter =
      entry.direction === 'CREDIT' ? balance + entry.amountMinor : balance - entry.amountMinor;
    if (
      entry.walletId !== wallet.id ||
      entry.currency !== wallet.currency ||
      entry.entrySequence !== expectedSequence ||
      entry.previousEntryHash !== expectedPreviousHash ||
      entry.balanceBeforeMinor !== balance ||
      entry.balanceAfterMinor !== expectedAfter ||
      entry.amountMinor <= 0n ||
      entry.balanceBeforeMinor < 0n ||
      entry.balanceAfterMinor < 0n ||
      !HASH_PATTERN.test(entry.entryHash) ||
      LedgerHashChain.calculate(entry) !== entry.entryHash
    ) {
      valid = false;
    }
    balance = entry.balanceAfterMinor;
    expectedPreviousHash = entry.entryHash;
  }

  return Object.freeze({
    calculatedBalanceMinor: balance,
    auditChainValid:
      valid &&
      expectedSequence === wallet.ledgerSequence &&
      expectedPreviousHash === wallet.lastLedgerHash,
    entriesScanned: entries.length,
  });
}

export class IncrementalReconcileWalletUseCase {
  readonly #clock: Clock;

  public constructor(
    private readonly transactionRunner: TransactionRunner<IncrementalReconciliationTransactionContext>,
    dependencies: IncrementalReconciliationDependencies = {},
  ) {
    this.#clock = dependencies.clock ?? new SystemClock();
  }

  public execute(walletId: string): Promise<IncrementalWalletReconciliationResult> {
    return this.transactionRunner.run(
      async ({ accounting, reconciliationCheckpoints, wallets }) => {
        const wallet = await wallets.lockById(walletId);
        if (wallet === null) {
          throw new WalletNotFoundError();
        }

        const checkpoint = await reconciliationCheckpoints.findByWalletId(walletId);
        if (checkpoint === null) {
          return this.fullScan(wallet, 'CREATED', accounting, reconciliationCheckpoints);
        }

        const checkpointValid = await this.isCheckpointValid(
          wallet,
          checkpoint,
          reconciliationCheckpoints,
        );
        if (!checkpointValid) {
          return this.fullScan(wallet, 'REBUILT', accounting, reconciliationCheckpoints);
        }

        const entries = await reconciliationCheckpoints.listLedgerEntriesAfter(
          wallet.id,
          checkpoint.ledgerSequence,
        );
        const ledger = assessLedgerSuffix(
          entries,
          wallet,
          checkpoint.ledgerSequence,
          checkpoint.ledgerEntryHash,
          checkpoint.calculatedBalanceMinor,
        );
        if (!ledger.auditChainValid) {
          return this.fullScan(wallet, 'REBUILT', accounting, reconciliationCheckpoints);
        }

        return this.finish(
          wallet,
          ledger,
          entries.length === 0 ? 'UNCHANGED' : 'ADVANCED',
          accounting,
          reconciliationCheckpoints,
        );
      },
    );
  }

  private async isCheckpointValid(
    wallet: Wallet,
    checkpoint: Awaited<ReturnType<ReconciliationCheckpointRepository['findByWalletId']>> & {},
    repository: ReconciliationCheckpointRepository,
  ): Promise<boolean> {
    if (
      checkpoint.walletId !== wallet.id ||
      checkpoint.currency !== wallet.currency ||
      checkpoint.ledgerSequence < 0n ||
      checkpoint.ledgerSequence > wallet.ledgerSequence
    ) {
      return false;
    }
    if (checkpoint.ledgerSequence === 0n) {
      return checkpoint.ledgerEntryHash === null && checkpoint.calculatedBalanceMinor === 0n;
    }
    const anchor = await repository.findLedgerEntry(wallet.id, checkpoint.ledgerSequence);
    return (
      anchor !== null &&
      anchor.currency === checkpoint.currency &&
      anchor.entryHash === checkpoint.ledgerEntryHash &&
      anchor.balanceAfterMinor === checkpoint.calculatedBalanceMinor
    );
  }

  private async fullScan(
    wallet: Wallet,
    successStatus: 'CREATED' | 'REBUILT',
    accounting: IncrementalReconciliationTransactionContext['accounting'],
    repository: ReconciliationCheckpointRepository,
  ): Promise<IncrementalWalletReconciliationResult> {
    const entries = await repository.listLedgerEntriesAfter(wallet.id, 0n);
    const calculatedBalanceMinor = reconstructLedger(entries, wallet.currency);
    const ledger = Object.freeze({
      calculatedBalanceMinor,
      auditChainValid:
        LedgerHashChain.verify(entries, wallet.currency) &&
        wallet.ledgerSequence === BigInt(entries.length) &&
        wallet.lastLedgerHash === (entries.at(-1)?.entryHash ?? null),
      entriesScanned: entries.length,
    });
    return this.finish(wallet, ledger, successStatus, accounting, repository);
  }

  private async finish(
    wallet: Wallet,
    ledger: LedgerAssessment,
    successStatus: Exclude<ReconciliationCheckpointStatus, 'INVALIDATED'>,
    accounting: IncrementalReconciliationTransactionContext['accounting'],
    repository: ReconciliationCheckpointRepository,
  ): Promise<IncrementalWalletReconciliationResult> {
    const checkedEntries = safeEntryCount(wallet.ledgerSequence);
    const postings = await accounting.listWalletPostings(wallet.id);
    const accountingAssessment = assessAccounting(
      postings,
      wallet.id,
      wallet.currency,
      ledger.calculatedBalanceMinor,
      checkedEntries,
    );
    const consistent =
      wallet.balance.amountMinor === ledger.calculatedBalanceMinor &&
      accountingAssessment.balanced &&
      ledger.auditChainValid;

    if (consistent) {
      await repository.save(
        Object.freeze({
          walletId: wallet.id,
          currency: wallet.currency,
          ledgerSequence: wallet.ledgerSequence,
          ledgerEntryHash: wallet.lastLedgerHash,
          calculatedBalanceMinor: ledger.calculatedBalanceMinor,
          checkedAt: this.#clock.now(),
        }),
      );
    } else {
      await repository.deleteByWalletId(wallet.id);
    }

    return Object.freeze({
      walletId: wallet.id,
      currency: wallet.currency,
      storedBalanceMinor: wallet.balance.amountMinor,
      calculatedBalanceMinor: ledger.calculatedBalanceMinor,
      accountingBalanceMinor: accountingAssessment.accountingBalanceMinor,
      differenceMinor: wallet.balance.amountMinor - ledger.calculatedBalanceMinor,
      consistent,
      checkedEntries,
      accountingBalanced: accountingAssessment.balanced,
      auditChainValid: ledger.auditChainValid,
      checkpointStatus: consistent ? successStatus : 'INVALIDATED',
      entriesScanned: ledger.entriesScanned,
    });
  }
}
