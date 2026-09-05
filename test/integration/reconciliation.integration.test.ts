import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { Money } from '../../src/shared/domain/money.js';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import {
  ReconcileWalletUseCase,
  type WalletReconciliationResult,
} from '../../src/wallet/application/reconcile-wallet.use-case.js';
import type { WalletTransactionContext } from '../../src/wallet/application/ports/wallet-transaction-context.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import { ReconciliationPresenter } from '../../src/wallet/presentation/reconciliation.presenter.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';

interface FinancialSnapshot {
  readonly accountingJournals: readonly Readonly<Record<string, unknown>>[];
  readonly accountingPostings: readonly Readonly<Record<string, unknown>>[];
  readonly ledgerEntries: readonly Readonly<Record<string, unknown>>[];
  readonly wallet: Readonly<Record<string, unknown>>;
}

let databaseContext: DatabaseTestContext | undefined;
let createWallet: CreateWalletUseCase | undefined;
let reconcileWallet: ReconcileWalletUseCase | undefined;

setDefaultTimeout(60_000);

function context(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }

  return databaseContext;
}

function creator(): CreateWalletUseCase {
  if (createWallet === undefined) {
    throw new Error('Create-wallet use case is unavailable');
  }

  return createWallet;
}

function reconciler(): ReconcileWalletUseCase {
  if (reconcileWallet === undefined) {
    throw new Error('Reconciliation use case is unavailable');
  }

  return reconcileWallet;
}

async function createFundedWallet(amount: string): Promise<string> {
  const wallet = await creator().execute({
    playerId: randomUUID(),
    initialBalance: Money.create({ amount, currency: 'BRL' }),
    correlationId: randomUUID(),
  });

  return wallet.id;
}

async function reconcile(walletId: string): Promise<WalletReconciliationResult> {
  return reconciler().execute(walletId);
}

async function financialSnapshot(walletId: string): Promise<FinancialSnapshot> {
  const connection = context().orm.em.getConnection();
  const wallets = await connection.execute<Readonly<Record<string, unknown>>[]>(
    `select id, player_id, currency, balance_minor, version, ledger_sequence,
            last_ledger_hash, created_at, updated_at
       from wallets
      where id = ?`,
    [walletId],
  );
  const wallet = wallets[0];
  if (wallet === undefined) {
    throw new Error('Wallet snapshot is unavailable');
  }

  const ledgerEntries = await connection.execute<Readonly<Record<string, unknown>>[]>(
    `select id, wallet_id, transaction_id, entry_sequence, direction, amount_minor,
            currency, balance_before_minor, balance_after_minor, previous_entry_hash,
            entry_hash, created_at
       from wallet_ledger_entries
      where wallet_id = ?
      order by entry_sequence`,
    [walletId],
  );
  const accountingJournals = await connection.execute<Readonly<Record<string, unknown>>[]>(
    `select id, transaction_id, wallet_id, created_at
       from accounting_journals
      where wallet_id = ?
      order by created_at, id`,
    [walletId],
  );
  const accountingPostings = await connection.execute<Readonly<Record<string, unknown>>[]>(
    `select posting.id, posting.journal_id, posting.account_id, posting.direction,
            posting.amount_minor, posting.currency, posting.created_at
       from accounting_postings posting
       join accounting_journals journal on journal.id = posting.journal_id
      where journal.wallet_id = ?
      order by posting.created_at, posting.id`,
    [walletId],
  );

  return Object.freeze({
    wallet: Object.freeze({ ...wallet }),
    ledgerEntries: Object.freeze(ledgerEntries.map((row) => Object.freeze({ ...row }))),
    accountingJournals: Object.freeze(accountingJournals.map((row) => Object.freeze({ ...row }))),
    accountingPostings: Object.freeze(accountingPostings.map((row) => Object.freeze({ ...row }))),
  });
}

async function associateForeignJournal(targetWalletId: string, donorWalletId: string) {
  const connection = context().orm.em.getConnection();
  const journals = await connection.execute<{ readonly id: string }[]>(
    `select id
       from accounting_journals
      where wallet_id = ?
      order by created_at, id
      limit 1`,
    [donorWalletId],
  );
  const journalId = journals[0]?.id;
  if (journalId === undefined) {
    throw new Error('Donor accounting journal is unavailable');
  }

  await connection.execute(
    'alter table accounting_journals disable trigger accounting_journals_immutable',
  );
  await connection.execute(
    'alter table accounting_journals disable trigger accounting_journals_financial_consistency',
  );
  try {
    await connection.execute('update accounting_journals set wallet_id = ? where id = ?', [
      targetWalletId,
      journalId,
    ]);
  } finally {
    await connection.execute(
      'alter table accounting_journals enable trigger accounting_journals_financial_consistency',
    );
    await connection.execute(
      'alter table accounting_journals enable trigger accounting_journals_immutable',
    );
  }

  return journalId;
}

async function corruptOpeningLedgerHash(walletId: string): Promise<string> {
  const connection = context().orm.em.getConnection();
  const corruptedHash = 'f'.repeat(64);

  await connection.execute(
    'alter table wallet_ledger_entries disable trigger wallet_ledger_entries_immutable',
  );
  await connection.execute(
    'alter table wallet_ledger_entries disable trigger wallet_ledger_entries_head_consistent',
  );
  await connection.execute(
    'alter table wallet_ledger_entries disable trigger wallet_ledger_entries_financial_consistency',
  );
  try {
    await connection.execute(
      'update wallet_ledger_entries set entry_hash = ? where wallet_id = ?',
      [corruptedHash, walletId],
    );
  } finally {
    await connection.execute(
      'alter table wallet_ledger_entries enable trigger wallet_ledger_entries_financial_consistency',
    );
    await connection.execute(
      'alter table wallet_ledger_entries enable trigger wallet_ledger_entries_head_consistent',
    );
    await connection.execute(
      'alter table wallet_ledger_entries enable trigger wallet_ledger_entries_immutable',
    );
  }

  return corruptedHash;
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('reconciliation');
  await databaseContext.orm.migrator.up();

  const runner = new MikroOrmTransactionRunner<WalletTransactionContext>(
    databaseContext.orm,
    createWalletTransactionContext,
  );
  createWallet = new CreateWalletUseCase(runner);
  reconcileWallet = new ReconcileWalletUseCase(runner);
});

afterAll(async () => {
  await databaseContext?.close();
});

describe('Wallet financial reconciliation', () => {
  test('reports exact operational, accounting, and audit evidence for a clean wallet', async () => {
    const walletId = await createFundedWallet('250.00');
    const before = await financialSnapshot(walletId);

    const result = await reconcile(walletId);

    expect(ReconciliationPresenter.present(result)).toEqual({
      walletId,
      storedBalance: { amount: '250.00', currency: 'BRL' },
      calculatedBalance: { amount: '250.00', currency: 'BRL' },
      accountingBalance: { amount: '250.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
      accountingBalanced: true,
      auditChainValid: true,
    });
    expect(await financialSnapshot(walletId)).toEqual(before);
  });

  test('detects a balanced journal associated with the wrong wallet without repairing it', async () => {
    const walletId = await createFundedWallet('100.00');
    const donorWalletId = await createFundedWallet('75.00');
    const foreignJournalId = await associateForeignJournal(walletId, donorWalletId);
    const corrupted = await financialSnapshot(walletId);

    const result = await reconcile(walletId);

    expect(await financialSnapshot(walletId)).toEqual(corrupted);
    expect(ReconciliationPresenter.present(result)).toEqual({
      walletId,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      accountingBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 1,
      accountingBalanced: false,
      auditChainValid: true,
    });
    expect(corrupted.accountingJournals.some(({ id }) => id === foreignJournalId)).toBe(true);
  });

  test('detects audit-chain tampering without changing the ledger or materialized wallet', async () => {
    const walletId = await createFundedWallet('125.00');
    const corruptedHash = await corruptOpeningLedgerHash(walletId);
    const corrupted = await financialSnapshot(walletId);

    const result = await reconcile(walletId);

    expect(await financialSnapshot(walletId)).toEqual(corrupted);
    expect(ReconciliationPresenter.present(result)).toEqual({
      walletId,
      storedBalance: { amount: '125.00', currency: 'BRL' },
      calculatedBalance: { amount: '125.00', currency: 'BRL' },
      accountingBalance: { amount: '125.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 1,
      accountingBalanced: true,
      auditChainValid: false,
    });
    expect(corrupted.ledgerEntries[0]?.entry_hash).toBe(corruptedHash);
  });
});
