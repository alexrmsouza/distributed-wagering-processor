import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';
import {
  postJson,
  requireTestService,
  startTestServices,
  stopTestServices,
  type TestServiceProcess,
} from '../support/service-process.js';

let databaseContext: DatabaseTestContext | undefined;
let services: readonly TestServiceProcess[] = [];

setDefaultTimeout(120_000);

function getDatabaseContext(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }
  return databaseContext;
}

function getService(index: number): TestServiceProcess {
  return requireTestService(services, index);
}

async function post(baseUrl: string, path: string, body: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (idempotencyKey !== undefined) {
    headers['idempotency-key'] = idempotencyKey;
  }
  return postJson(baseUrl, path, body, headers);
}

async function createWallet(baseUrl: string) {
  const playerId = randomUUID();
  const result = await post(baseUrl, '/wallets', {
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  expect(result.response.status).toBe(201);
  return { playerId, walletId: String(result.body.id) };
}

function createBet(wallet: { readonly playerId: string; readonly walletId: string }) {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-independent-wallets',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  };
}

beforeAll(async () => {
  const context = await createDatabaseTestContext('independent_wallets');
  databaseContext = context;
  await context.orm.migrator.up();
  services = await startTestServices(context.databaseName, 2);
});

afterAll(async () => {
  await stopTestServices(services);
  await databaseContext?.close();
});

describe('Independent-wallet concurrency across service processes', () => {
  test('a lock on one wallet does not prevent another wallet from progressing', async () => {
    const [walletA, walletB] = await Promise.all([
      createWallet(getService(0).baseUrl),
      createWallet(getService(1).baseUrl),
    ]);
    const wagerA = createBet(walletA);
    const wagerB = createBet(walletB);
    let blockedRequest: ReturnType<typeof post> | undefined;

    await getDatabaseContext()
      .orm.em.fork()
      .transactional(async (entityManager) => {
        await entityManager
          .getConnection()
          .execute(
            'select id from wallets where id = ? for update',
            [walletA.walletId],
            'all',
            entityManager.getTransactionContext(),
          );

        blockedRequest = post(
          getService(0).baseUrl,
          '/wagering/transactions',
          wagerA,
          randomUUID(),
        );
        let blockedRequestSettled = false;
        void blockedRequest.then(() => {
          blockedRequestSettled = true;
        });
        await Bun.sleep(150);

        const independentOutcome = await Promise.race([
          post(getService(1).baseUrl, '/wagering/transactions', wagerB, randomUUID()).then(
            (result) => ({ kind: 'result' as const, result }),
          ),
          Bun.sleep(5_000).then(() => ({ kind: 'timeout' as const })),
        ]);

        expect(independentOutcome.kind).toBe('result');
        if (independentOutcome.kind === 'result') {
          expect(independentOutcome.result.response.status).toBe(201);
          expect(independentOutcome.result.body).toMatchObject({
            status: 'PROCESSED',
            balance: { amount: '90.00', currency: 'BRL' },
          });
        }
        expect(blockedRequestSettled).toBeFalse();
      });

    if (blockedRequest === undefined) {
      throw new Error('The blocked request was not started');
    }
    const releasedOutcome = await blockedRequest;
    expect(releasedOutcome.response.status).toBe(201);
    expect(releasedOutcome.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '90.00', currency: 'BRL' },
    });

    const rows = await getDatabaseContext()
      .orm.em.getConnection()
      .execute<{ balance_minor: string; id: string }[]>(
        'select id::text, balance_minor::text from wallets where id in (?, ?) order by id',
        [walletA.walletId, walletB.walletId],
      );
    expect(rows.map(({ balance_minor }) => balance_minor)).toEqual(['9000', '9000']);
  });
});
