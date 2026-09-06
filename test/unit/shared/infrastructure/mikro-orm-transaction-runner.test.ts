import type { EntityManager } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { describe, expect, test } from 'bun:test';

import { MikroOrmTransactionRunner } from '../../../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import type { MikroOrmRequestContextAdapter } from '../../../../src/shared/infrastructure/mikro-orm-transaction-runner.js';

interface FakeContext {
  readonly attempt: number;
  readonly queries: readonly { readonly sql: string; readonly parameters: readonly unknown[] }[];
}

interface FakeOrmHarness {
  readonly orm: MikroORM;
  readonly transactionCount: () => number;
}

function createFakeOrm(): FakeOrmHarness {
  let transactionCount = 0;
  const orm = {
    em: {
      transactional: async <TResult>(work: (entityManager: EntityManager) => Promise<TResult>) => {
        transactionCount += 1;
        const queries: { sql: string; parameters: readonly unknown[] }[] = [];
        const entityManager = {
          attempt: transactionCount,
          getConnection: () => ({
            execute: (sql: string, parameters: readonly unknown[]) => {
              queries.push({ sql, parameters });
              return Promise.resolve([]);
            },
          }),
          getTransactionContext: () => Object.freeze({}),
          queries,
        } as unknown as EntityManager;
        return work(entityManager);
      },
    },
  } as unknown as MikroORM;

  return Object.freeze({ orm, transactionCount: () => transactionCount });
}

const requestContext = {
  run: <TResult>(work: () => Promise<TResult>) => work(),
} as MikroOrmRequestContextAdapter;

function createContext(entityManager: EntityManager): FakeContext {
  return entityManager as unknown as FakeContext;
}

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected promise to reject');
}

describe('MikroOrmTransactionRunner', () => {
  test('applies local lock and statement timeouts before business work', async () => {
    const harness = createFakeOrm();
    const runner = new MikroOrmTransactionRunner(harness.orm, createContext, requestContext, {
      lockTimeoutMs: 750,
      statementTimeoutMs: 12_000,
    });

    const queries = await runner.run((context) => Promise.resolve(context.queries));

    expect(queries).toEqual([
      {
        sql: "select set_config('lock_timeout', ?, true)",
        parameters: ['750ms'],
      },
      {
        sql: "select set_config('statement_timeout', ?, true)",
        parameters: ['12000ms'],
      },
    ]);
  });

  test('retries the whole transaction with a fresh context for transient SQLSTATE', async () => {
    const harness = createFakeOrm();
    const attempts: number[] = [];
    const runner = new MikroOrmTransactionRunner(harness.orm, createContext, requestContext, {
      maxAttempts: 3,
      retryBaseDelayMs: 0,
    });

    const result = await runner.run((context) => {
      attempts.push(context.attempt);
      if (context.attempt === 1) {
        const cause = Object.assign(new Error('deadlock'), { code: '40P01' });
        return Promise.reject(new Error('transaction failed', { cause }));
      }
      return Promise.resolve('committed');
    });

    expect(result).toBe('committed');
    expect(attempts).toEqual([1, 2]);
    expect(harness.transactionCount()).toBe(2);
  });

  test('finds a transient SQLSTATE beneath a non-database wrapper code', async () => {
    const harness = createFakeOrm();
    const runner = new MikroOrmTransactionRunner(harness.orm, createContext, requestContext, {
      maxAttempts: 2,
      retryBaseDelayMs: 0,
    });

    const result = await runner.run((context) => {
      if (context.attempt === 1) {
        const cause = Object.assign(new Error('lock timeout'), { code: '55P03' });
        return Promise.reject(
          Object.assign(new Error('wrapped failure', { cause }), { code: 'DB' }),
        );
      }
      return Promise.resolve('committed');
    });

    expect(result).toBe('committed');
    expect(harness.transactionCount()).toBe(2);
  });

  test('does not retry non-transient database failures', async () => {
    const harness = createFakeOrm();
    const runner = new MikroOrmTransactionRunner(harness.orm, createContext, requestContext, {
      maxAttempts: 3,
      retryBaseDelayMs: 0,
    });
    const failure = Object.assign(new Error('unique violation'), { code: '23505' });

    const received = await rejectedValue(runner.run(() => Promise.reject(failure)));
    expect(received).toBe(failure);
    expect(harness.transactionCount()).toBe(1);
  });

  test('stops after the configured number of transient attempts', async () => {
    const harness = createFakeOrm();
    const runner = new MikroOrmTransactionRunner(harness.orm, createContext, requestContext, {
      maxAttempts: 2,
      retryBaseDelayMs: 0,
    });
    const driverException = Object.assign(new Error('serialization failure'), { code: '40001' });
    const failure = Object.assign(new Error('transaction failed'), { driverException });

    const received = await rejectedValue(runner.run(() => Promise.reject(failure)));
    expect(received).toBe(failure);
    expect(harness.transactionCount()).toBe(2);
  });
});
