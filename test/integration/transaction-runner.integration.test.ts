import type { EntityManager } from '@mikro-orm/core';
import { expect, test } from 'bun:test';

import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/mikro-orm-transaction-runner.js';
import { queryRows } from '../../src/shared/infrastructure/persistence/transactional-query.js';
import { createDatabaseTestContext } from '../support/database-test-context.js';

interface TimeoutSettings {
  readonly lock_timeout: string;
  readonly statement_timeout: string;
}

async function queryTimeouts(entityManager: EntityManager): Promise<TimeoutSettings> {
  const rows = await queryRows<TimeoutSettings>(
    entityManager,
    "select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout",
  );
  const settings = rows[0];
  if (settings === undefined) {
    throw new Error('PostgreSQL did not return timeout settings');
  }
  return settings;
}

test('applies transaction-local PostgreSQL timeouts and restores session defaults', async () => {
  const context = await createDatabaseTestContext('transaction_timeout_test');

  try {
    const baselineRows = await queryRows<TimeoutSettings>(
      context.orm.em,
      "select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout",
    );
    const baseline = baselineRows[0];
    if (baseline === undefined) {
      throw new Error('PostgreSQL did not return baseline timeout settings');
    }

    const runner = new MikroOrmTransactionRunner(
      context.orm,
      (entityManager) => entityManager,
      undefined,
      { lockTimeoutMs: 750, statementTimeoutMs: 12_000, retryBaseDelayMs: 0 },
    );

    const inside = await runner.run(queryTimeouts);
    const afterRows = await queryRows<TimeoutSettings>(
      context.orm.em,
      "select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout",
    );

    expect(inside).toEqual({ lock_timeout: '750ms', statement_timeout: '12s' });
    expect(afterRows[0]).toEqual(baseline);
  } finally {
    await context.close();
  }
});

test('retries the complete PostgreSQL transaction with a fresh EntityManager', async () => {
  const context = await createDatabaseTestContext('transaction_retry_test');

  try {
    await context.orm.em
      .getConnection()
      .execute('create table transaction_retry_probe (id integer primary key)');
    const runner = new MikroOrmTransactionRunner(
      context.orm,
      (entityManager) => entityManager,
      undefined,
      { maxAttempts: 2, retryBaseDelayMs: 0 },
    );
    const entityManagers = new Set<EntityManager>();
    let attempt = 0;

    await runner.run(async (entityManager) => {
      attempt += 1;
      entityManagers.add(entityManager);
      await entityManager
        .getConnection()
        .execute(
          'insert into transaction_retry_probe (id) values (1)',
          [],
          'run',
          entityManager.getTransactionContext(),
        );
      if (attempt === 1) {
        throw Object.assign(new Error('serialization failure'), { code: '40001' });
      }
    });

    const rows = await queryRows<{ id: number }>(
      context.orm.em,
      'select id from transaction_retry_probe order by id',
    );

    expect(attempt).toBe(2);
    expect(entityManagers.size).toBe(2);
    expect(rows).toEqual([{ id: 1 }]);
  } finally {
    await context.close();
  }
});
