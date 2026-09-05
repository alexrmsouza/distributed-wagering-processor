import { randomUUID } from 'node:crypto';

import type { EntityManager } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import { createTestEnvironment } from '../support/test-environment.js';

let application: INestApplication | undefined;
let baseUrl: string;
let databaseContext: DatabaseTestContext | undefined;

setDefaultTimeout(30_000);

interface WalletSnapshot {
  readonly balanceMinor: bigint;
  readonly currency: string;
  readonly lastLedgerHash: string;
  readonly ledgerSequence: bigint;
  readonly playerId: string;
  readonly version: bigint;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }

  return value as Record<string, unknown>;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return asRecord((await response.json()) as unknown);
}

async function executeInTransaction(
  entityManager: EntityManager,
  sql: string,
  parameters: readonly unknown[],
): Promise<void> {
  await entityManager
    .getConnection()
    .execute(sql, [...parameters], 'run', entityManager.getTransactionContext());
}

async function createWallet(amount = '100.00'): Promise<string> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
    }),
  });
  const body = await readJson(response);

  expect(response.status).toBe(201);
  expect(body.id).toBeString();

  return String(body.id);
}

function getDatabaseContext(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }

  return databaseContext;
}

async function getWalletSnapshot(walletId: string): Promise<WalletSnapshot> {
  const rows = await getDatabaseContext()
    .orm.em.getConnection()
    .execute<
      {
        balance_minor: string;
        currency: string;
        last_ledger_hash: string | null;
        ledger_sequence: string;
        player_id: string;
        version: string;
      }[]
    >(
      `select balance_minor, currency, last_ledger_hash, ledger_sequence, player_id, version
       from wallets
      where id = ?`,
      [walletId],
    );
  const row = rows[0];

  if (row?.last_ledger_hash === null || row === undefined) {
    throw new Error('Wallet ledger head is unavailable');
  }

  return {
    balanceMinor: BigInt(row.balance_minor),
    currency: row.currency.trim(),
    lastLedgerHash: row.last_ledger_hash.trim(),
    ledgerSequence: BigInt(row.ledger_sequence),
    playerId: row.player_id,
    version: BigInt(row.version),
  };
}

async function insertCredit(
  walletId: string,
  createdAt: Date,
  entryId = randomUUID(),
): Promise<string> {
  const { LedgerHashChain } = await import('../../src/wallet/domain/ledger-hash-chain.js');
  const snapshot = await getWalletSnapshot(walletId);
  const amountMinor = 100n;
  const balanceAfterMinor = snapshot.balanceMinor + amountMinor;
  const entrySequence = snapshot.ledgerSequence + 1n;
  const transactionId = randomUUID();
  const journalId = randomUUID();
  const providerAccountId = randomUUID();
  const providerId = `provider-${randomUUID()}`;
  const entryHash = LedgerHashChain.calculate({
    walletId,
    transactionId,
    entrySequence,
    direction: 'CREDIT',
    amountMinor,
    currency: snapshot.currency,
    balanceBeforeMinor: snapshot.balanceMinor,
    balanceAfterMinor,
    previousEntryHash: snapshot.lastLedgerHash,
    createdAt,
  });

  await getDatabaseContext().orm.em.transactional(async (entityManager) => {
    const playerAccounts = await entityManager.getConnection().execute<{ id: string }[]>(
      `select id from accounts
        where kind = 'PLAYER_BALANCE' and owner_id = ? and currency = ?`,
      [walletId, snapshot.currency],
      'all',
      entityManager.getTransactionContext(),
    );
    const playerAccountId = playerAccounts[0]?.id;

    if (playerAccountId === undefined) {
      throw new Error('Player balance account is unavailable');
    }

    await executeInTransaction(
      entityManager,
      `insert into accounts (id, kind, owner_id, currency, created_at)
       values (?, 'PROVIDER_CLEARING', ?, ?, ?)`,
      [providerAccountId, providerId, snapshot.currency, createdAt],
    );
    await executeInTransaction(
      entityManager,
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
          status, observed_balance_minor, processed_at, created_at, updated_at)
       values (?, ?, ?, ?, repeat('a', 64), ?, ?, ?, 'pagination-test', 'WIN', ?, ?,
               'PROCESSED', ?, ?, ?, ?)`,
      [
        transactionId,
        providerId,
        randomUUID(),
        randomUUID(),
        walletId,
        snapshot.playerId,
        randomUUID(),
        amountMinor.toString(),
        snapshot.currency,
        balanceAfterMinor.toString(),
        createdAt,
        createdAt,
        createdAt,
      ],
    );
    await executeInTransaction(
      entityManager,
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, entry_sequence, direction, amount_minor,
          currency, balance_before_minor, balance_after_minor, previous_entry_hash,
          entry_hash, created_at)
       values (?, ?, ?, ?, 'CREDIT', ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId,
        walletId,
        transactionId,
        entrySequence.toString(),
        amountMinor.toString(),
        snapshot.currency,
        snapshot.balanceMinor.toString(),
        balanceAfterMinor.toString(),
        snapshot.lastLedgerHash,
        entryHash,
        createdAt,
      ],
    );
    await executeInTransaction(
      entityManager,
      `update wallets
          set balance_minor = ?, version = ?, ledger_sequence = ?, last_ledger_hash = ?,
              updated_at = ?
        where id = ?`,
      [
        balanceAfterMinor.toString(),
        (snapshot.version + 1n).toString(),
        entrySequence.toString(),
        entryHash,
        createdAt,
        walletId,
      ],
    );
    await executeInTransaction(
      entityManager,
      'insert into accounting_journals (id, transaction_id, wallet_id, created_at) values (?, ?, ?, ?)',
      [journalId, transactionId, walletId, createdAt],
    );
    await executeInTransaction(
      entityManager,
      `insert into accounting_postings
         (id, journal_id, account_id, direction, amount_minor, currency, created_at)
       values (?, ?, ?, 'DEBIT', ?, ?, ?),
              (?, ?, ?, 'CREDIT', ?, ?, ?)`,
      [
        randomUUID(),
        journalId,
        providerAccountId,
        amountMinor.toString(),
        snapshot.currency,
        createdAt,
        randomUUID(),
        journalId,
        playerAccountId,
        amountMinor.toString(),
        snapshot.currency,
        createdAt,
      ],
    );
  });

  return entryId;
}

function ledgerItems(body: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(body.items)) {
    throw new TypeError('Expected ledger items');
  }

  const items = body.items as unknown[];
  return items.map(asRecord);
}

beforeAll(async () => {
  const { WalletModule } = await import('../../src/wallet/wallet.module.js');

  databaseContext = await createDatabaseTestContext('wallet_reconciliation');
  await databaseContext.orm.migrator.up();

  const environment = createTestEnvironment({ DATABASE_NAME: databaseContext.databaseName });
  const { createMikroOrmConfig } =
    await import('../../src/bootstrap/configuration/mikro-orm.config.js');

  @Module({
    imports: [
      MikroOrmModule.forRoot(createMikroOrmConfig(environment.configuration)),
      WalletModule,
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest uses this class as a module metadata root.
  class WalletReconciliationTestModule {}

  application = await NestFactory.create(WalletReconciliationTestModule, { logger: false });
  await application.listen(0, '127.0.0.1');
  baseUrl = await application.getUrl();
});

afterAll(async () => {
  await application?.close();
  await databaseContext?.close();
});

describe('Wallet ledger pagination and reconciliation', () => {
  test('uses an opaque keyset cursor stable when an earlier row is inserted', async () => {
    const walletId = await createWallet();
    const openingRows = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ created_at: Date | string; id: string }[]>(
        'select id, created_at from wallet_ledger_entries where wallet_id = ?',
        [walletId],
      );
    const opening = openingRows[0];

    if (opening === undefined) {
      throw new Error('Opening ledger entry is unavailable');
    }

    const openingCreatedAt = new Date(opening.created_at);
    const firstCreditId = await insertCredit(
      walletId,
      new Date(openingCreatedAt.getTime() + 1_000),
    );
    const secondCreditId = await insertCredit(
      walletId,
      new Date(openingCreatedAt.getTime() + 2_000),
    );
    const firstPageResponse = await fetch(`${baseUrl}/wallets/${walletId}/ledger?limit=2`);
    const firstPage = await readJson(firstPageResponse);
    const firstPageItems = ledgerItems(firstPage);

    expect(firstPageResponse.status).toBe(200);
    expect(firstPageItems.map(({ id }) => id)).toEqual([opening.id, firstCreditId]);
    expect(firstPage.nextCursor).toBeString();
    expect(String(firstPage.nextCursor)).not.toContain(firstCreditId);
    expect(() => {
      JSON.parse(String(firstPage.nextCursor));
    }).toThrow();

    const insertedBeforeCursorId = '00000000-0000-7000-8000-000000000001';
    await insertCredit(walletId, openingCreatedAt, insertedBeforeCursorId);

    const secondPageResponse = await fetch(
      `${baseUrl}/wallets/${walletId}/ledger?limit=2&cursor=${encodeURIComponent(String(firstPage.nextCursor))}`,
    );
    const secondPage = await readJson(secondPageResponse);
    const secondPageIds = ledgerItems(secondPage).map(({ id }) => id);

    expect(secondPageResponse.status).toBe(200);
    expect(secondPageIds).toContain(secondCreditId);
    expect(secondPageIds).not.toContain(firstCreditId);
    expect(secondPageIds).not.toContain(insertedBeforeCursorId);
  });

  test('returns 400 for a malformed ledger cursor', async () => {
    const walletId = await createWallet();
    const response = await fetch(`${baseUrl}/wallets/${walletId}/ledger?cursor=not-a-cursor`);

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ failureCode: 'INVALID_PAYLOAD' });
  });

  test('reports a consistent wallet across operational, accounting, and audit records', async () => {
    const walletId = await createWallet('250.00');
    const response = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
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
  });

  test('reports divergence without repairing persisted financial state', async () => {
    const walletId = await createWallet('100.00');

    await getDatabaseContext()
      .orm.em.getConnection()
      .execute('alter table wallets disable trigger wallets_ledger_head_consistent');
    try {
      await getDatabaseContext()
        .orm.em.getConnection()
        .execute('update wallets set balance_minor = 10100 where id = ?', [walletId]);
    } finally {
      await getDatabaseContext()
        .orm.em.getConnection()
        .execute('alter table wallets enable trigger wallets_ledger_head_consistent');
    }

    const response = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      walletId,
      storedBalance: { amount: '101.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      accountingBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '1.00', currency: 'BRL' },
      consistent: false,
      accountingBalanced: true,
      auditChainValid: true,
    });

    const persisted = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ balance_minor: string }[]>('select balance_minor from wallets where id = ?', [
        walletId,
      ]);
    expect(BigInt(persisted[0]?.balance_minor ?? '0')).toBe(10_100n);
  });
});
