import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';

import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { FailpointController } from '../../src/shared/infrastructure/failpoints/failpoint-controller.js';
import { Money } from '../../src/shared/domain/money.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { NOOP_WALLET_LOCK_METRICS } from '../../src/wallet/application/ports/wallet-lock-metrics.js';
import { createWalletTransactionContext } from '../../src/wallet/infrastructure/persistence/wallet-transaction-context.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { createWageringTransactionContext } from '../../src/wagering/infrastructure/persistence/wagering-transaction-context.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';

let databaseContext: DatabaseTestContext | undefined;

setDefaultTimeout(60_000);

function getDatabaseContext(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }

  return databaseContext;
}

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }

  throw new Error('Expected operation to fail');
}

async function financialCounts(walletId: string): Promise<Record<string, string>> {
  const rows = await getDatabaseContext()
    .orm.em.getConnection()
    .execute<Record<string, string>[]>(
      `select
       (select count(*)::text from wager_transactions where wallet_id = ?) as transactions,
       (select count(*)::text from wallet_ledger_entries where wallet_id = ?) as ledger_entries,
       (select count(*)::text from accounting_journals where wallet_id = ?) as journals,
       (select count(*)::text from accounting_postings posting
         join accounting_journals journal on journal.id = posting.journal_id
        where journal.wallet_id = ?) as postings,
       (select count(*)::text from outbox_messages where aggregate_id = ?) as outbox_messages,
       (select balance_minor::text from wallets where id = ?) as balance_minor,
       (select version::text from wallets where id = ?) as wallet_version`,
      [walletId, walletId, walletId, walletId, walletId, walletId, walletId],
    );

  const row = rows[0];
  if (row === undefined) {
    throw new Error('Financial counts are unavailable');
  }
  return row;
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('wagering_atomicity');
  await databaseContext.orm.migrator.up();
});

afterAll(async () => {
  await databaseContext?.close();
});

test('rolls back the wager claim and every financial write when the failpoint fires', async () => {
  const context = getDatabaseContext();
  const walletRunner = new MikroOrmTransactionRunner(context.orm, createWalletTransactionContext);
  const createWallet = new CreateWalletUseCase(walletRunner);
  const wallet = await createWallet.execute({
    playerId: randomUUID(),
    initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
  });
  const before = await financialCounts(wallet.id);
  const failpoints = FailpointController.create({ enabled: true, environment: 'test' });
  failpoints.arm('before_financial_commit');
  const wageringRunner = new MikroOrmTransactionRunner(context.orm, (entityManager) =>
    createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
  );
  const processWager = new ProcessWagerTransactionUseCase(wageringRunner, { failpoints });

  const error = await captureError(() =>
    processWager.execute({
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-atomicity',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: Money.create({ amount: '25.00', currency: 'BRL' }),
      correlationId: randomUUID(),
    }),
  );

  expect(error.message).toContain('Failpoint triggered: before_financial_commit');
  expect(await financialCounts(wallet.id)).toEqual(before);
});

test('rolls back a reversal outcome and every inverse financial write when the failpoint fires', async () => {
  const context = getDatabaseContext();
  const walletRunner = new MikroOrmTransactionRunner(context.orm, createWalletTransactionContext);
  const createWallet = new CreateWalletUseCase(walletRunner);
  const wallet = await createWallet.execute({
    playerId: randomUUID(),
    initialBalance: Money.create({ amount: '100.00', currency: 'BRL' }),
  });
  const wageringRunner = new MikroOrmTransactionRunner(context.orm, (entityManager) =>
    createWageringTransactionContext(entityManager, NOOP_WALLET_LOCK_METRICS),
  );
  const sourceExternalTransactionId = randomUUID();
  await new ProcessWagerTransactionUseCase(wageringRunner).execute({
    providerId: 'provider-a',
    externalTransactionId: sourceExternalTransactionId,
    idempotencyKey: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-reversal-atomicity',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.create({ amount: '25.00', currency: 'BRL' }),
    correlationId: randomUUID(),
  });
  const before = await financialCounts(wallet.id);
  const failpoints = FailpointController.create({ enabled: true, environment: 'test' });
  failpoints.arm('before_financial_commit');
  const processWager = new ProcessWagerTransactionUseCase(wageringRunner, { failpoints });

  const error = await captureError(() =>
    processWager.execute({
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-reversal-atomicity',
      gameId: 'fortune-chimp',
      kind: 'REFUND',
      money: Money.create({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: sourceExternalTransactionId,
      correlationId: randomUUID(),
    }),
  );

  expect(error.message).toContain('Failpoint triggered: before_financial_commit');
  expect(await financialCounts(wallet.id)).toEqual(before);
});
