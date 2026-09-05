import { randomUUID } from 'node:crypto';

import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import { createTestEnvironment } from '../support/test-environment.js';

interface WagerRequest {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET' | 'WIN' | 'LOSS';
  readonly money: {
    readonly amount: string;
    readonly currency: string;
  };
}

let application: INestApplication | undefined;
let baseUrl: string;
let databaseContext: DatabaseTestContext | undefined;

setDefaultTimeout(60_000);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }

  return value as Record<string, unknown>;
}

function getDatabaseContext(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }

  return databaseContext;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return asRecord((await response.json()) as unknown);
}

async function postWallet(playerId: string, amount = '100.00', currency = 'BRL') {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
  });

  return { body: await readJson(response), response };
}

function createWager(
  walletId: string,
  playerId: string,
  overrides: Partial<WagerRequest> = {},
): WagerRequest {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

async function postWager(request: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (idempotencyKey !== undefined) {
    headers['idempotency-key'] = idempotencyKey;
  }

  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });

  return { body: await readJson(response), response };
}

async function getJson(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  return { body: await readJson(response), response };
}

beforeAll(async () => {
  const [{ WalletModule }, { WageringModule }] = await Promise.all([
    import('../../src/wallet/wallet.module.js'),
    import('../../src/wagering/wagering.module.js'),
  ]);

  databaseContext = await createDatabaseTestContext('wagering_http');
  await databaseContext.orm.migrator.up();

  const environment = createTestEnvironment({ DATABASE_NAME: databaseContext.databaseName });
  const { createMikroOrmConfig } =
    await import('../../src/bootstrap/configuration/mikro-orm.config.js');

  @Module({
    imports: [
      MikroOrmModule.forRoot(createMikroOrmConfig(environment.configuration)),
      WalletModule,
      WageringModule,
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest uses this class as a module metadata root.
  class WageringHttpTestModule {}

  application = await NestFactory.create(WageringHttpTestModule, { logger: false });
  await application.listen(0, '127.0.0.1');
  baseUrl = await application.getUrl();
});

afterAll(async () => {
  await application?.close();
  await databaseContext?.close();
});

describe('Wagering HTTP contract', () => {
  test.each([
    { kind: 'BET' as const, amount: '25.00', expectedBalance: '75.00' },
    { kind: 'WIN' as const, amount: '20.00', expectedBalance: '120.00' },
    { kind: 'LOSS' as const, amount: '15.00', expectedBalance: '100.00' },
  ])('returns the exact processed payload for $kind', async (scenario) => {
    const playerId = randomUUID();
    const wallet = await postWallet(playerId);
    expect(wallet.response.status).toBe(201);

    const request = createWager(String(wallet.body.id), playerId, {
      kind: scenario.kind,
      money: { amount: scenario.amount, currency: 'BRL' },
    });
    const result = await postWager(
      request,
      `${request.providerId}:${request.externalTransactionId}`,
    );

    expect(result.response.status).toBe(201);
    expect(result.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: scenario.expectedBalance, currency: 'BRL' },
      idempotentReplay: false,
    });
    const events = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ event_type: string }[]>(
        `select event_type from outbox_messages
          where payload -> 'data' ->> 'transactionId' = ?
          order by event_type`,
        [String(result.body.transactionId)],
      );
    expect(events.map(({ event_type }) => event_type)).toEqual(
      scenario.kind === 'LOSS'
        ? ['WagerTransactionProcessed']
        : ['WagerTransactionProcessed', 'WalletBalanceChanged'],
    );
  });

  test('returns 400 with INVALID_PAYLOAD for a malformed request', async () => {
    const playerId = randomUUID();
    const wallet = await postWallet(playerId);
    const request = createWager(String(wallet.body.id), playerId, {
      money: { amount: '25.0', currency: 'BRL' },
    });

    const result = await postWager(request, randomUUID());

    expect(result.response.status).toBe(400);
    expect(result.body).toMatchObject({ failureCode: 'INVALID_PAYLOAD' });
  });

  test('returns 400 with INVALID_PAYLOAD when Idempotency-Key is missing', async () => {
    const playerId = randomUUID();
    const wallet = await postWallet(playerId);
    const result = await postWager(createWager(String(wallet.body.id), playerId));

    expect(result.response.status).toBe(400);
    expect(result.body).toMatchObject({ failureCode: 'INVALID_PAYLOAD' });
  });

  test('returns 409 without a second effect when an idempotency key has another payload', async () => {
    const playerId = randomUUID();
    const wallet = await postWallet(playerId);
    const request = createWager(String(wallet.body.id), playerId);
    const idempotencyKey = randomUUID();
    const initial = await postWager(request, idempotencyKey);
    const conflict = await postWager(
      { ...request, money: { amount: '30.00', currency: 'BRL' } },
      idempotencyKey,
    );

    expect(initial.response.status).toBe(201);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({ failureCode: 'IDEMPOTENCY_CONFLICT' });

    const persistedWallet = await fetch(`${baseUrl}/wallets/${String(wallet.body.id)}`);
    expect(await readJson(persistedWallet)).toMatchObject({
      balance: { amount: '75.00', currency: 'BRL' },
      version: 2,
    });
  });

  test.each([
    {
      name: 'insufficient funds',
      request: { kind: 'BET' as const, money: { amount: '125.00', currency: 'BRL' } },
      failureCode: 'INSUFFICIENT_FUNDS',
    },
    {
      name: 'currency mismatch',
      request: { kind: 'BET' as const, money: { amount: '25.00', currency: 'USD' } },
      failureCode: 'CURRENCY_MISMATCH',
    },
  ])('returns 422 for $name', async (scenario) => {
    const playerId = randomUUID();
    const wallet = await postWallet(playerId);
    const request = createWager(String(wallet.body.id), playerId, scenario.request);
    const result = await postWager(request, randomUUID());

    expect(result.response.status).toBe(422);
    expect(result.body.transactionId).toBeString();
    expect(result.body).toMatchObject({
      status: 'REJECTED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: scenario.failureCode,
    });
    const events = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ event_type: string }[]>(
        `select event_type from outbox_messages
          where payload -> 'data' ->> 'transactionId' = ?`,
        [String(result.body.transactionId)],
      );
    expect(events).toEqual([{ event_type: 'WagerTransactionRejected' }]);
  });

  test('returns 422 with WALLET_NOT_FOUND for an unknown wallet', async () => {
    const request = createWager(randomUUID(), randomUUID());
    const result = await postWager(request, randomUUID());

    expect(result.response.status).toBe(422);
    expect(result.body).toMatchObject({ failureCode: 'WALLET_NOT_FOUND' });
  });

  test('returns the same immutable transaction through both query identities', async () => {
    const playerId = randomUUID();
    const wallet = await postWallet(playerId);
    const request = createWager(String(wallet.body.id), playerId, {
      kind: 'WIN',
      money: { amount: '12.34', currency: 'BRL' },
    });
    const created = await postWager(request, randomUUID());
    const transactionId = String(created.body.transactionId);

    const [byId, byProviderIdentity] = await Promise.all([
      getJson(`/wagering/transactions/${transactionId}`),
      getJson(
        `/providers/${request.providerId}/wagering/transactions/${request.externalTransactionId}`,
      ),
    ]);

    expect(byId.response.status).toBe(200);
    expect(byProviderIdentity.response.status).toBe(200);
    expect(byProviderIdentity.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({
      transactionId,
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      walletId: request.walletId,
      playerId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: 'WIN',
      money: { amount: '12.34', currency: 'BRL' },
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: 'PROCESSED',
      failureCode: null,
      observedBalance: { amount: '112.34', currency: 'BRL' },
    });
    expect(typeof byId.body.processedAt).toBe('string');
    expect(typeof byId.body.createdAt).toBe('string');
  });

  test('returns 404 for unknown transaction query identities', async () => {
    const [byId, byProviderIdentity] = await Promise.all([
      getJson(`/wagering/transactions/${randomUUID()}`),
      getJson('/providers/provider-a/wagering/transactions/unknown-transaction'),
    ]);

    expect(byId.response.status).toBe(404);
    expect(byId.body).toMatchObject({ failureCode: 'WAGER_TRANSACTION_NOT_FOUND' });
    expect(byProviderIdentity.response.status).toBe(404);
    expect(byProviderIdentity.body).toMatchObject({
      failureCode: 'WAGER_TRANSACTION_NOT_FOUND',
    });
  });

  test('keeps the audit chain and accounting balanced with provider-isolated clearing accounts', async () => {
    const playerId = randomUUID();
    const wallet = await postWallet(playerId);
    const walletId = String(wallet.body.id);
    const providerA = createWager(walletId, playerId, {
      providerId: 'provider-a',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    });
    const providerB = createWager(walletId, playerId, {
      providerId: 'provider-b',
      kind: 'WIN',
      money: { amount: '5.00', currency: 'BRL' },
    });

    expect((await postWager(providerA, randomUUID())).response.status).toBe(201);
    expect((await postWager(providerB, randomUUID())).response.status).toBe(201);

    const reconciliationResponse = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
    });
    const reconciliation = {
      body: await readJson(reconciliationResponse),
      response: reconciliationResponse,
    };
    expect(reconciliation.response.status).toBe(200);
    expect(reconciliation.body).toMatchObject({
      walletId,
      storedBalance: { amount: '85.00', currency: 'BRL' },
      calculatedBalance: { amount: '85.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      accountingBalanced: true,
      auditChainValid: true,
    });

    const clearingAccounts = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ currency: string; owner_id: string }[]>(
        `select owner_id, currency
         from accounts
        where kind = 'PROVIDER_CLEARING' and owner_id in (?, ?)
        order by owner_id`,
        [providerA.providerId, providerB.providerId],
      );
    expect(clearingAccounts).toEqual([
      { owner_id: 'provider-a', currency: 'BRL' },
      { owner_id: 'provider-b', currency: 'BRL' },
    ]);
  });
});
