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

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  return { response, body: asRecord((await response.json()) as unknown) };
}

beforeAll(async () => {
  const [{ WalletModule }, { WageringModule }] = await Promise.all([
    import('../../src/wallet/wallet.module.js'),
    import('../../src/wagering/wagering.module.js'),
  ]);

  databaseContext = await createDatabaseTestContext('idempotency_replay');
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
  class IdempotencyReplayTestModule {}

  application = await NestFactory.create(IdempotencyReplayTestModule, { logger: false });
  await application.listen(0, '127.0.0.1');
  baseUrl = await application.getUrl();
});

afterAll(async () => {
  await application?.close();
  await databaseContext?.close();
});

describe('Persistent idempotency replay', () => {
  test('returns the original observed balance after a later wallet movement', async () => {
    const playerId = randomUUID();
    const wallet = await post('/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(wallet.response.status).toBe(201);
    const walletId = String(wallet.body.id);
    const originalRequest = {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: 'round-replay',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const idempotencyKey = randomUUID();

    const original = await post('/wagering/transactions', originalRequest, {
      'idempotency-key': idempotencyKey,
    });
    expect(original.response.status).toBe(201);
    expect(original.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const laterMovement = await post(
      '/wagering/transactions',
      {
        ...originalRequest,
        externalTransactionId: randomUUID(),
        kind: 'WIN',
        money: { amount: '50.00', currency: 'BRL' },
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(laterMovement.response.status).toBe(201);
    expect(laterMovement.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '125.00', currency: 'BRL' },
    });

    const replay = await post('/wagering/transactions', originalRequest, {
      'idempotency-key': idempotencyKey,
    });

    expect(replay.response.status).toBe(201);
    expect(replay.body).toEqual({
      transactionId: original.body.transactionId,
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: true,
    });

    const rows = await databaseContext?.orm.em.getConnection().execute<
      {
        journals: string;
        ledger_entries: string;
        outbox_messages: string;
        transactions: string;
      }[]
    >(
      `select
         (select count(*)::text from wager_transactions
           where provider_id = ? and idempotency_key = ?) as transactions,
         (select count(*)::text from wallet_ledger_entries
           where transaction_id = ?) as ledger_entries,
         (select count(*)::text from accounting_journals
           where transaction_id = ?) as journals,
         (select count(*)::text from outbox_messages
           where payload -> 'data' ->> 'transactionId' = ?) as outbox_messages`,
      [
        originalRequest.providerId,
        idempotencyKey,
        original.body.transactionId,
        original.body.transactionId,
        original.body.transactionId,
      ],
    );

    expect(rows?.[0]).toEqual({
      transactions: '1',
      ledger_entries: '1',
      journals: '1',
      outbox_messages: '2',
    });
  });
});
