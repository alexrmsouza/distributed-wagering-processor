import { randomUUID } from 'node:crypto';

import type { EntityManager } from '@mikro-orm/core';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { Account, AccountKind } from '../../src/accounting/domain/account.js';
import { AccountingJournal } from '../../src/accounting/domain/accounting-journal.js';
import { AccountingPosting } from '../../src/accounting/domain/accounting-posting.js';
import { Money } from '../../src/shared/domain/money.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { executeStatement } from '../../src/shared/infrastructure/persistence/transactional-query.js';
import type { WageringTransactionContext } from '../../src/wagering/application/ports/wagering-transaction-context.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessableWagerKind,
} from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { createWageringTransactionContext } from '../../src/wagering/infrastructure/persistence/wagering-transaction-context.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { NOOP_WALLET_LOCK_METRICS } from '../../src/wallet/application/ports/wallet-lock-metrics.js';
import { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry.js';
import type { Wallet } from '../../src/wallet/domain/wallet.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';

interface DirectWageringContext extends WageringTransactionContext {
  readonly entityManager: EntityManager;
}

interface ProcessedSource {
  readonly transactionId: string;
  readonly externalTransactionId: string;
  readonly providerId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: ProcessableWagerKind;
  readonly money: Money;
}

interface RefundCandidate {
  readonly id: string;
  readonly externalTransactionId: string;
  readonly referenceExternalTransactionId: string;
  readonly referenceTransactionId: string;
  readonly providerId: string;
  readonly wallet: Wallet;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly money: Money;
}

type CompatibilityViolation =
  | 'self-reference'
  | 'external identity'
  | 'REFUND source kind'
  | 'provider'
  | 'wallet'
  | 'player'
  | 'currency'
  | 'amount'
  | 'round'
  | 'game';

let databaseContext: DatabaseTestContext | undefined;

setDefaultTimeout(120_000);

function context(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }

  return databaseContext;
}

function directRunner(): MikroOrmTransactionRunner<DirectWageringContext> {
  return new MikroOrmTransactionRunner(context().orm, (entityManager) => ({
    ...createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
    entityManager,
  }));
}

function wageringRunner(): MikroOrmTransactionRunner<WageringTransactionContext> {
  return new MikroOrmTransactionRunner(context().orm, (entityManager) =>
    createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
  );
}

async function createWallet(currency = 'BRL', playerId: string = randomUUID()): Promise<Wallet> {
  return new CreateWalletUseCase(
    new MikroOrmTransactionRunner(context().orm, createWalletTransactionContext),
  ).execute({
    playerId,
    initialBalance: Money.create({ amount: '100.00', currency }),
  });
}

async function createProcessedSource(
  wallet: Wallet,
  overrides: Partial<{
    readonly providerId: string;
    readonly roundId: string;
    readonly gameId: string;
    readonly kind: 'BET' | 'WIN';
    readonly money: Money;
  }> = {},
): Promise<ProcessedSource> {
  const externalTransactionId = randomUUID();
  const providerId = overrides.providerId ?? 'provider-a';
  const roundId = overrides.roundId ?? 'round-database-invariant';
  const gameId = overrides.gameId ?? 'fortune-chimp';
  const kind = overrides.kind ?? 'BET';
  const money = overrides.money ?? Money.create({ amount: '25.00', currency: wallet.currency });
  const result = await new ProcessWagerTransactionUseCase(wageringRunner()).execute({
    providerId,
    externalTransactionId,
    idempotencyKey: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId,
    gameId,
    kind,
    money,
    correlationId: randomUUID(),
  });

  expect(result.status).toBe('PROCESSED');

  return {
    transactionId: result.transactionId,
    externalTransactionId,
    providerId,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId,
    gameId,
    kind,
    money,
  };
}

function candidateFrom(source: ProcessedSource, wallet: Wallet): RefundCandidate {
  return {
    id: randomUUID(),
    externalTransactionId: randomUUID(),
    referenceExternalTransactionId: source.externalTransactionId,
    referenceTransactionId: source.transactionId,
    providerId: source.providerId,
    wallet,
    playerId: source.playerId,
    roundId: source.roundId,
    gameId: source.gameId,
    money: Money.create({ amount: source.money.toJSON().amount, currency: wallet.currency }),
  };
}

async function persistProcessedRefundGraph(candidate: RefundCandidate): Promise<void> {
  const occurredAt = new Date();

  await directRunner().run(async (transactionContext) => {
    const wallet = await transactionContext.wallets.lockById(candidate.wallet.id);
    if (wallet === null) {
      throw new Error('Candidate wallet was not found');
    }

    const ledgerEntry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: candidate.id,
      entrySequence: wallet.ledgerSequence + 1n,
      direction: 'CREDIT',
      amount: candidate.money,
      balanceBefore: wallet.balance,
      previousEntryHash: wallet.lastLedgerHash,
      createdAt: occurredAt,
    });
    const changedWallet = wallet
      .credit(candidate.money, occurredAt)
      .withLedgerHead(ledgerEntry.entrySequence, ledgerEntry.entryHash);

    await executeStatement(
      transactionContext.entityManager,
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
          reference_external_transaction_id, reference_transaction_id, status,
          failure_code, observed_balance_minor, observed_balance_currency, retry_attempts,
          next_retry_at, retry_expires_at, processed_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REFUND', ?, ?, ?, ?, 'PROCESSED',
               null, ?, ?, 0, null, null, ?, ?, ?)`,
      [
        candidate.id,
        candidate.providerId,
        candidate.externalTransactionId,
        randomUUID(),
        'a'.repeat(64),
        wallet.id,
        candidate.playerId,
        candidate.roundId,
        candidate.gameId,
        candidate.money.amountMinor.toString(),
        candidate.money.currency,
        candidate.referenceExternalTransactionId,
        candidate.referenceTransactionId,
        changedWallet.balance.amountMinor.toString(),
        changedWallet.balance.currency,
        occurredAt,
        occurredAt,
        occurredAt,
      ],
    );

    const playerAccount = await transactionContext.accounting.getOrCreateAccount(
      Account.create({
        id: randomUUID(),
        kind: AccountKind.PlayerBalance,
        ownerId: wallet.id,
        currency: wallet.currency,
        createdAt: occurredAt,
      }),
    );
    const clearingAccount = await transactionContext.accounting.getOrCreateAccount(
      Account.create({
        id: randomUUID(),
        kind: AccountKind.ProviderClearing,
        ownerId: candidate.providerId,
        currency: wallet.currency,
        createdAt: occurredAt,
      }),
    );
    const journalId = randomUUID();
    const journal = AccountingJournal.create({
      id: journalId,
      transactionId: candidate.id,
      walletId: wallet.id,
      createdAt: occurredAt,
      postings: [
        AccountingPosting.create({
          id: randomUUID(),
          journalId,
          accountId: clearingAccount.id,
          direction: 'DEBIT',
          amount: candidate.money,
          createdAt: occurredAt,
        }),
        AccountingPosting.create({
          id: randomUUID(),
          journalId,
          accountId: playerAccount.id,
          direction: 'CREDIT',
          amount: candidate.money,
          createdAt: occurredAt,
        }),
      ],
    });

    await transactionContext.wallets.appendLedgerEntry(ledgerEntry);
    await transactionContext.accounting.insertJournal(journal);
    await transactionContext.wallets.save(changedWallet);
  });
}

async function expectCompatibilityRejection(candidate: RefundCandidate): Promise<void> {
  try {
    await persistProcessedRefundGraph(candidate);
    throw new Error('Expected PostgreSQL to reject an incompatible processed reversal');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('has incompatible reference context');
  }
}

async function createScenario(violation: CompatibilityViolation): Promise<RefundCandidate> {
  const sourceWallet = await createWallet();
  const source = await createProcessedSource(sourceWallet, {
    ...(violation === 'REFUND source kind' ? { kind: 'WIN' as const } : {}),
  });
  let candidateWallet = sourceWallet;

  if (violation === 'wallet') {
    candidateWallet = await createWallet('BRL');
  } else if (violation === 'currency') {
    candidateWallet = await createWallet('USD', source.playerId);
  }

  const candidate = candidateFrom(source, candidateWallet);

  switch (violation) {
    case 'self-reference':
      return {
        ...candidate,
        referenceExternalTransactionId: candidate.externalTransactionId,
        referenceTransactionId: candidate.id,
      };
    case 'external identity':
      return { ...candidate, referenceExternalTransactionId: randomUUID() };
    case 'REFUND source kind':
      return candidate;
    case 'provider':
      return { ...candidate, providerId: 'provider-b' };
    case 'wallet':
      return candidate;
    case 'player':
      return { ...candidate, playerId: randomUUID() };
    case 'currency':
      return candidate;
    case 'amount':
      return { ...candidate, money: Money.create({ amount: '20.00', currency: 'BRL' }) };
    case 'round':
      return { ...candidate, roundId: 'different-round' };
    case 'game':
      return { ...candidate, gameId: 'different-game' };
  }
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('reversal_db_invariants');
  await databaseContext.orm.migrator.up();
});

afterAll(async () => {
  await databaseContext?.close();
});

describe('PostgreSQL reversal reference invariants', () => {
  test.each<CompatibilityViolation>([
    'self-reference',
    'external identity',
    'REFUND source kind',
    'provider',
    'wallet',
    'player',
    'currency',
    'amount',
    'round',
    'game',
  ])(
    'rejects a financially consistent processed REFUND with incompatible %s',
    async (violation) => {
      await expectCompatibilityRejection(await createScenario(violation));
    },
  );
});
