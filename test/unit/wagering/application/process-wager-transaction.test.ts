import { describe, expect, test } from 'bun:test';

import type { AccountingJournal } from '../../../../src/accounting/domain/accounting-journal.js';
import type { Account } from '../../../../src/accounting/domain/account.js';
import type { OutboxMessage } from '../../../../src/messaging/domain/outbox-message.js';
import type { TransactionRunner } from '../../../../src/shared/application/transaction-runner.js';
import { Money } from '../../../../src/shared/domain/money.js';
import type { WalletLedgerEntry } from '../../../../src/wallet/domain/wallet-ledger-entry.js';
import { Wallet } from '../../../../src/wallet/domain/wallet.js';

const OCCURRED_AT = new Date('2026-09-04T18:00:00.000Z');
const LATER_AT = new Date('2026-09-04T18:05:00.000Z');
const WALLET_ID = '01991a20-7b40-7000-8000-000000000101';
const PLAYER_ID = '01991a20-7b40-7000-8000-000000000102';
const PROVIDER_ID = 'provider-a';

interface TransactionSnapshot {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly status: string;
}

interface TransactionRecord {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  toState?(): TransactionSnapshot;
}

interface TransactionContext {
  readonly wallets: ReturnType<typeof createWalletRepository>;
  readonly wagerTransactions: ReturnType<typeof createWagerTransactionRepository>;
  readonly accounting: ReturnType<typeof createAccountingRepository>;
  readonly outbox: ReturnType<typeof createOutboxRepository>;
  readonly pendingReferences: ReturnType<typeof createPendingReferenceRepository>;
}

interface TestCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET' | 'WIN' | 'LOSS';
  readonly money: Money;
  readonly correlationId: string;
}

interface ProcessWagerTransactionResult {
  readonly transactionId: string;
  readonly status: 'PROCESSED' | 'REJECTED' | 'FAILED';
  readonly balance: Money;
  readonly idempotentReplay: boolean;
  readonly failureCode?: string;
}

interface ProcessWagerTransaction {
  execute(command: TestCommand): Promise<ProcessWagerTransactionResult>;
}

type ProcessWagerTransactionConstructor = new (
  transactionRunner: TransactionRunner<TransactionContext>,
  dependencies: {
    readonly clock: { now(): Date };
    readonly generateId: () => string;
  },
) => ProcessWagerTransaction;

interface ProcessWagerTransactionModule {
  readonly ProcessWagerTransactionUseCase: ProcessWagerTransactionConstructor;
}

function loadUseCase(): Promise<ProcessWagerTransactionModule> {
  const modulePath = '../../../../src/wagering/application/process-wager-transaction.use-case.js';

  return import(modulePath) as Promise<ProcessWagerTransactionModule>;
}

function transactionState(transaction: TransactionRecord): TransactionSnapshot {
  return transaction.toState?.() ?? (transaction as TransactionSnapshot);
}

function createWallet(balance = '100.00', currency = 'BRL'): Wallet {
  return Wallet.rehydrate({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    balanceMinor: Money.create({ amount: balance, currency }).amountMinor,
    currency,
    version: 2n,
    ledgerSequence: 1n,
    lastLedgerHash: 'a'.repeat(64),
    createdAt: new Date('2026-09-04T17:00:00.000Z'),
    updatedAt: new Date('2026-09-04T17:00:00.000Z'),
  });
}

function createWalletRepository(initialWallet: Wallet | null) {
  let wallet = initialWallet;
  const saved: Wallet[] = [];
  const ledgerEntries: WalletLedgerEntry[] = [];
  let lockCount = 0;

  return {
    transactionBound: true as const,
    findById: (walletId: string) => Promise.resolve(wallet?.id === walletId ? wallet : null),
    findByPlayerAndCurrency: (playerId: string, currency: string) =>
      Promise.resolve(
        wallet?.playerId === playerId && wallet.currency === currency ? wallet : null,
      ),
    lockById: (walletId: string) => {
      lockCount += 1;
      return Promise.resolve(wallet?.id === walletId ? wallet : null);
    },
    insert: (inserted: Wallet) => {
      wallet = inserted;
      return Promise.resolve();
    },
    save: (updated: Wallet) => {
      wallet = updated;
      saved.push(updated);
      return Promise.resolve();
    },
    appendLedgerEntry: (entry: WalletLedgerEntry) => {
      ledgerEntries.push(entry);
      return Promise.resolve();
    },
    listLedgerPage: () => Promise.resolve(ledgerEntries),
    listLedgerStates: () => Promise.resolve(ledgerEntries.map((entry) => entry.toState())),
    replaceWallet: (replacement: Wallet) => {
      wallet = replacement;
    },
    get current(): Wallet | null {
      return wallet;
    },
    get saved(): readonly Wallet[] {
      return saved;
    },
    get ledgerEntries(): readonly WalletLedgerEntry[] {
      return ledgerEntries;
    },
    get lockCount(): number {
      return lockCount;
    },
  };
}

function createWagerTransactionRepository() {
  const records: TransactionRecord[] = [];

  return {
    transactionBound: true as const,
    findById: (transactionId: string) =>
      Promise.resolve(records.find(({ id }) => id === transactionId) ?? null),
    findByProviderAndExternalId: (providerId: string, externalTransactionId: string) =>
      Promise.resolve(
        records.find(
          (record) =>
            record.providerId === providerId &&
            record.externalTransactionId === externalTransactionId,
        ) ?? null,
      ),
    findByIdempotencyKey: (providerId: string, idempotencyKey: string) =>
      Promise.resolve(
        records.find(
          (record) => record.providerId === providerId && record.idempotencyKey === idempotencyKey,
        ) ?? null,
      ),
    insert: (transaction: TransactionRecord) => {
      const state = transactionState(transaction);
      const exists = records.some(
        (record) =>
          (record.providerId === state.providerId &&
            record.idempotencyKey === state.idempotencyKey) ||
          (record.providerId === state.providerId &&
            record.externalTransactionId === state.externalTransactionId),
      );
      if (!exists) {
        records.push(transaction);
      }
      return Promise.resolve(!exists);
    },
    save: (transaction: TransactionRecord) => {
      const index = records.findIndex(({ id }) => id === transaction.id);
      if (index === -1) {
        records.push(transaction);
      } else {
        records[index] = transaction;
      }
      return Promise.resolve();
    },
    get records(): readonly TransactionRecord[] {
      return records;
    },
  };
}

function createAccountingRepository() {
  const accounts: Account[] = [];
  const journals: AccountingJournal[] = [];

  return {
    transactionBound: true as const,
    getOrCreateAccount: (candidate: Account) => {
      const existing = accounts.find(
        ({ kind, ownerId, currency }) =>
          kind === candidate.kind &&
          ownerId === candidate.ownerId &&
          currency === candidate.currency,
      );
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      accounts.push(candidate);
      return Promise.resolve(candidate);
    },
    insertJournal: (journal: AccountingJournal) => {
      journals.push(journal);
      return Promise.resolve();
    },
    listWalletPostings: () => Promise.resolve([]),
    get accounts(): readonly Account[] {
      return accounts;
    },
    get journals(): readonly AccountingJournal[] {
      return journals;
    },
  };
}

function createOutboxRepository() {
  const messages: OutboxMessage[] = [];

  return {
    transactionBound: true as const,
    insert: (message: OutboxMessage) => {
      messages.push(message);
      return Promise.resolve();
    },
    get messages(): readonly OutboxMessage[] {
      return messages;
    },
  };
}

function createPendingReferenceRepository() {
  return {
    transactionBound: true as const,
    initialize: () => Promise.resolve(),
    claimDue: () => Promise.resolve([]),
    lockPending: () => Promise.resolve(null),
    lockLeased: () => Promise.resolve(null),
    reschedule: () => Promise.resolve(),
    clearLease: () => Promise.resolve(),
  };
}

function createTransactionRunner(context: TransactionContext) {
  let runCount = 0;
  const runner: TransactionRunner<TransactionContext> = {
    run: async (work) => {
      runCount += 1;
      return work(context);
    },
  };

  return {
    runner,
    get runCount(): number {
      return runCount;
    },
  };
}

function baseCommand(overrides: Partial<TestCommand> = {}): TestCommand {
  return {
    providerId: PROVIDER_ID,
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.create({ amount: '25.00', currency: 'BRL' }),
    correlationId: 'correlation-123',
    ...overrides,
  };
}

function createFixture(initialWallet: Wallet | null = createWallet()) {
  const wallets = createWalletRepository(initialWallet);
  const wagerTransactions = createWagerTransactionRepository();
  const accounting = createAccountingRepository();
  const outbox = createOutboxRepository();
  const pendingReferences = createPendingReferenceRepository();
  const transaction = createTransactionRunner({
    wallets,
    wagerTransactions,
    accounting,
    outbox,
    pendingReferences,
  });
  let idSequence = 200;

  return {
    wallets,
    wagerTransactions,
    accounting,
    outbox,
    transaction,
    dependencies: {
      clock: { now: () => OCCURRED_AT },
      generateId: () => {
        idSequence += 1;
        return `01991a20-7b40-7000-8000-${idSequence.toString().padStart(12, '0')}`;
      },
    },
  };
}

function eventTypes(fixture: ReturnType<typeof createFixture>): readonly string[] {
  return fixture.outbox.messages
    .map((message) => message.toState().eventType)
    .sort((left, right) => left.localeCompare(right));
}

describe('ProcessWagerTransactionUseCase', () => {
  test('processes a BET as one exact debit with balanced financial effects', async () => {
    const { ProcessWagerTransactionUseCase } = await loadUseCase();
    const fixture = createFixture();
    const useCase = new ProcessWagerTransactionUseCase(
      fixture.transaction.runner,
      fixture.dependencies,
    );

    const result = await useCase.execute(baseCommand());

    expect(result).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: false,
    });
    expect(result.balance.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(fixture.wallets.current?.balance.toJSON()).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
    expect(fixture.wallets.current?.version).toBe(3n);
    expect(fixture.wallets.ledgerEntries).toHaveLength(1);
    expect(fixture.wallets.ledgerEntries[0]).toMatchObject({ direction: 'DEBIT' });
    expect(fixture.wallets.ledgerEntries[0]?.amount.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
    expect(fixture.accounting.journals).toHaveLength(1);
    expect(fixture.accounting.journals[0]?.isBalanced()).toBe(true);
    expect(fixture.wagerTransactions.records).toHaveLength(1);
    expect(eventTypes(fixture)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('processes a WIN as one exact credit with balanced financial effects', async () => {
    const { ProcessWagerTransactionUseCase } = await loadUseCase();
    const fixture = createFixture();
    const useCase = new ProcessWagerTransactionUseCase(
      fixture.transaction.runner,
      fixture.dependencies,
    );

    const result = await useCase.execute(baseCommand({ kind: 'WIN' }));

    expect(result.status).toBe('PROCESSED');
    expect(result.balance.toJSON()).toEqual({ amount: '125.00', currency: 'BRL' });
    expect(fixture.wallets.current?.balance.toJSON()).toEqual({
      amount: '125.00',
      currency: 'BRL',
    });
    expect(fixture.wallets.ledgerEntries).toHaveLength(1);
    expect(fixture.wallets.ledgerEntries[0]).toMatchObject({ direction: 'CREDIT' });
    expect(fixture.accounting.journals).toHaveLength(1);
    expect(fixture.accounting.journals[0]?.isBalanced()).toBe(true);
    expect(eventTypes(fixture)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('records a LOSS as processed without any financial movement', async () => {
    const { ProcessWagerTransactionUseCase } = await loadUseCase();
    const fixture = createFixture();
    const useCase = new ProcessWagerTransactionUseCase(
      fixture.transaction.runner,
      fixture.dependencies,
    );

    const result = await useCase.execute(baseCommand({ kind: 'LOSS' }));

    expect(result).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(result.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(fixture.wallets.current?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(fixture.wallets.saved).toHaveLength(0);
    expect(fixture.wallets.ledgerEntries).toHaveLength(0);
    expect(fixture.accounting.journals).toHaveLength(0);
    expect(fixture.wagerTransactions.records).toHaveLength(1);
    expect(eventTypes(fixture)).toEqual(['WagerTransactionProcessed']);
  });

  test('persists insufficient funds as a terminal rejection without financial effects', async () => {
    const { ProcessWagerTransactionUseCase } = await loadUseCase();
    const fixture = createFixture();
    const useCase = new ProcessWagerTransactionUseCase(
      fixture.transaction.runner,
      fixture.dependencies,
    );

    const result = await useCase.execute(
      baseCommand({ money: Money.create({ amount: '100.01', currency: 'BRL' }) }),
    );

    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: false,
    });
    expect(result.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(fixture.wallets.saved).toHaveLength(0);
    expect(fixture.wallets.ledgerEntries).toHaveLength(0);
    expect(fixture.accounting.journals).toHaveLength(0);
    expect(fixture.wagerTransactions.records).toHaveLength(1);
    expect(eventTypes(fixture)).toEqual(['WagerTransactionRejected']);
  });

  test.each([
    {
      name: 'an unknown wallet',
      wallet: null,
      command: baseCommand(),
      failureCode: 'WALLET_NOT_FOUND',
      expectedRecords: 0,
    },
    {
      name: 'a player that does not own the wallet',
      wallet: createWallet(),
      command: baseCommand({
        playerId: '01991a20-7b40-7000-8000-000000000999',
      }),
      failureCode: 'WALLET_NOT_FOUND',
      expectedRecords: 1,
    },
    {
      name: 'money in another currency',
      wallet: createWallet(),
      command: baseCommand({
        money: Money.create({ amount: '25.00', currency: 'USD' }),
      }),
      failureCode: 'CURRENCY_MISMATCH',
      expectedRecords: 1,
    },
  ])(
    'rejects $name before creating financial effects',
    async ({ wallet, command, failureCode, expectedRecords }) => {
      const { ProcessWagerTransactionUseCase } = await loadUseCase();
      const fixture = createFixture(wallet);
      const useCase = new ProcessWagerTransactionUseCase(
        fixture.transaction.runner,
        fixture.dependencies,
      );

      const result = await useCase.execute(command);

      expect(result).toMatchObject({ status: 'REJECTED', failureCode });
      expect(fixture.wallets.saved).toHaveLength(0);
      expect(fixture.wallets.ledgerEntries).toHaveLength(0);
      expect(fixture.accounting.journals).toHaveLength(0);
      expect(fixture.wagerTransactions.records).toHaveLength(expectedRecords);
    },
  );

  test('returns the original outcome and observed balance for an exact replay', async () => {
    const { ProcessWagerTransactionUseCase } = await loadUseCase();
    const fixture = createFixture();
    const useCase = new ProcessWagerTransactionUseCase(
      fixture.transaction.runner,
      fixture.dependencies,
    );
    const command = baseCommand();

    const original = await useCase.execute(command);
    const originalEffectCounts = {
      transactions: fixture.wagerTransactions.records.length,
      ledger: fixture.wallets.ledgerEntries.length,
      journals: fixture.accounting.journals.length,
      events: fixture.outbox.messages.length,
      locks: fixture.wallets.lockCount,
    };
    const movedLater = fixture.wallets.current?.credit(
      Money.create({ amount: '10.00', currency: 'BRL' }),
      LATER_AT,
    );
    if (movedLater === undefined) {
      throw new Error('Expected the fixture wallet to exist');
    }
    fixture.wallets.replaceWallet(movedLater);

    const replay = await useCase.execute(
      baseCommand({ correlationId: 'correlation-from-retry-transport' }),
    );

    expect(original.balance.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    const currentWallet = fixture.wallets.current;
    if (currentWallet === null) {
      throw new Error('Expected the fixture wallet to exist');
    }
    expect(currentWallet.balance.toJSON()).toEqual({ amount: '85.00', currency: 'BRL' });
    expect(replay).toMatchObject({
      transactionId: original.transactionId,
      status: 'PROCESSED',
      idempotentReplay: true,
    });
    expect(replay.balance.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect({
      transactions: fixture.wagerTransactions.records.length,
      ledger: fixture.wallets.ledgerEntries.length,
      journals: fixture.accounting.journals.length,
      events: fixture.outbox.messages.length,
      locks: fixture.wallets.lockCount,
    }).toEqual(originalEffectCounts);
  });

  test('rejects an idempotency key reused with a different canonical business payload', async () => {
    const { ProcessWagerTransactionUseCase } = await loadUseCase();
    const fixture = createFixture();
    const useCase = new ProcessWagerTransactionUseCase(
      fixture.transaction.runner,
      fixture.dependencies,
    );
    const command = baseCommand();

    await useCase.execute(command);
    const originalEffectCounts = {
      transactions: fixture.wagerTransactions.records.length,
      ledger: fixture.wallets.ledgerEntries.length,
      journals: fixture.accounting.journals.length,
      events: fixture.outbox.messages.length,
      locks: fixture.wallets.lockCount,
    };

    expect(
      useCase.execute(baseCommand({ money: Money.create({ amount: '24.99', currency: 'BRL' }) })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect({
      transactions: fixture.wagerTransactions.records.length,
      ledger: fixture.wallets.ledgerEntries.length,
      journals: fixture.accounting.journals.length,
      events: fixture.outbox.messages.length,
      locks: fixture.wallets.lockCount,
    }).toEqual(originalEffectCounts);
  });
});
