import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import type { WalletAccountingPosting } from '../../../src/accounting/application/ports/accounting.repository.js';
import type { TransactionRunner } from '../../../src/shared/application/transaction-runner.js';
import {
  IncrementalReconcileWalletUseCase,
  type IncrementalReconciliationTransactionContext,
} from '../../../src/wallet/application/incremental-reconcile-wallet.use-case.js';
import type {
  ReconciliationCheckpoint,
  ReconciliationCheckpointRepository,
} from '../../../src/wallet/application/ports/reconciliation-checkpoint.repository.js';
import type { WalletLedgerEntryState } from '../../../src/wallet/domain/wallet-ledger-entry.js';
import { LedgerHashChain } from '../../../src/wallet/domain/ledger-hash-chain.js';
import { Wallet } from '../../../src/wallet/domain/wallet.js';

const walletId = randomUUID();
const playerId = randomUUID();
const baseTime = new Date('2026-09-05T12:00:00.000Z');

function ledgerEntry(
  sequence: bigint,
  direction: 'CREDIT' | 'DEBIT',
  amountMinor: bigint,
  balanceBeforeMinor: bigint,
  previousEntryHash: string | null,
): WalletLedgerEntryState {
  const input = {
    walletId,
    transactionId: randomUUID(),
    entrySequence: sequence,
    direction,
    amountMinor,
    currency: 'BRL',
    balanceBeforeMinor,
    balanceAfterMinor:
      direction === 'CREDIT' ? balanceBeforeMinor + amountMinor : balanceBeforeMinor - amountMinor,
    previousEntryHash,
    createdAt: new Date(baseTime.getTime() + Number(sequence) * 1_000),
  } as const;

  return Object.freeze({ id: randomUUID(), ...input, entryHash: LedgerHashChain.calculate(input) });
}

function postingsFor(
  entries: readonly WalletLedgerEntryState[],
): readonly WalletAccountingPosting[] {
  return Object.freeze(
    entries.flatMap((entry) => {
      const journalId = randomUUID();
      return [
        {
          journalId,
          accountKind: 'PLAYER_BALANCE' as const,
          accountOwnerId: walletId,
          direction: entry.direction,
          amountMinor: entry.amountMinor,
          currency: 'BRL',
        },
        {
          journalId,
          accountKind: 'PROVIDER_CLEARING' as const,
          accountOwnerId: 'provider',
          direction: entry.direction === 'CREDIT' ? ('DEBIT' as const) : ('CREDIT' as const),
          amountMinor: entry.amountMinor,
          currency: 'BRL',
        },
      ];
    }),
  );
}

function wallet(entries: readonly WalletLedgerEntryState[]): Wallet {
  const latest = entries.at(-1);
  return Wallet.rehydrate({
    id: walletId,
    playerId,
    balanceMinor: latest?.balanceAfterMinor ?? 0n,
    currency: 'BRL',
    version: BigInt(entries.length + 1),
    ledgerSequence: BigInt(entries.length),
    lastLedgerHash: latest?.entryHash ?? null,
    createdAt: baseTime,
    updatedAt: baseTime,
  });
}

function fixture() {
  const first = ledgerEntry(1n, 'CREDIT', 10_000n, 0n, null);
  const second = ledgerEntry(2n, 'DEBIT', 2_000n, 10_000n, first.entryHash);
  const third = ledgerEntry(3n, 'CREDIT', 1_000n, 8_000n, second.entryHash);
  let entries: readonly WalletLedgerEntryState[] = Object.freeze([first, second]);
  let checkpoint: ReconciliationCheckpoint | null = null;

  const checkpointRepository: ReconciliationCheckpointRepository = {
    transactionBound: true,
    findByWalletId: () => Promise.resolve(checkpoint),
    findLedgerEntry: (_walletId, sequence) =>
      Promise.resolve(entries.find((entry) => entry.entrySequence === sequence) ?? null),
    listLedgerEntriesAfter: (_walletId, sequence) =>
      Promise.resolve(Object.freeze(entries.filter((entry) => entry.entrySequence > sequence))),
    save: (value) => {
      checkpoint = value;
      return Promise.resolve();
    },
    deleteByWalletId: () => {
      checkpoint = null;
      return Promise.resolve();
    },
  };

  const context = {
    wallets: {
      transactionBound: true,
      lockById: () => Promise.resolve(wallet(entries)),
    },
    accounting: {
      transactionBound: true,
      listWalletPostings: () => Promise.resolve(postingsFor(entries)),
    },
    reconciliationCheckpoints: checkpointRepository,
  } as IncrementalReconciliationTransactionContext;
  const runner: TransactionRunner<IncrementalReconciliationTransactionContext> = {
    run: (operation) => operation(context),
  };
  const useCase = new IncrementalReconcileWalletUseCase(runner, {
    clock: { now: () => new Date('2026-09-05T13:00:00.000Z') },
  });

  return {
    useCase,
    appendThird: () => {
      entries = Object.freeze([first, second, third]);
    },
    corruptCheckpoint: () => {
      if (checkpoint === null) {
        throw new Error('Checkpoint is unavailable');
      }
      checkpoint = Object.freeze({ ...checkpoint, ledgerEntryHash: 'f'.repeat(64) });
    },
    checkpoint: () => checkpoint,
  };
}

describe('Incremental wallet reconciliation', () => {
  test('creates, reuses, and advances a trusted checkpoint using only the ledger suffix', async () => {
    const state = fixture();

    const created = await state.useCase.execute(walletId);
    const unchanged = await state.useCase.execute(walletId);
    state.appendThird();
    const advanced = await state.useCase.execute(walletId);

    expect(created.checkpointStatus).toBe('CREATED');
    expect(created.entriesScanned).toBe(2);
    expect(unchanged.checkpointStatus).toBe('UNCHANGED');
    expect(unchanged.entriesScanned).toBe(0);
    expect(advanced.checkpointStatus).toBe('ADVANCED');
    expect(advanced.entriesScanned).toBe(1);
    expect(advanced.consistent).toBe(true);
    expect(state.checkpoint()?.ledgerSequence).toBe(3n);
  });

  test('falls back to a full scan when the checkpoint anchor is invalid', async () => {
    const state = fixture();
    await state.useCase.execute(walletId);
    state.corruptCheckpoint();

    const rebuilt = await state.useCase.execute(walletId);

    expect(rebuilt.checkpointStatus).toBe('REBUILT');
    expect(rebuilt.entriesScanned).toBe(2);
    expect(rebuilt.consistent).toBe(true);
    expect(state.checkpoint()?.ledgerEntryHash).not.toBe('f'.repeat(64));
  });
});
