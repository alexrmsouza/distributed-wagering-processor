import { expect, test } from 'bun:test';

import { createDatabaseTestContext } from '../support/database-test-context.js';

const EXPECTED_TABLES = [
  'accounting_journals',
  'accounting_postings',
  'accounts',
  'inbox_messages',
  'outbox_messages',
  'outbox_replay_audit',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallet_reconciliation_checkpoints',
  'wallets',
];

test('applies and reverses every financial migration', async () => {
  const context = await createDatabaseTestContext('migration_test');

  try {
    const migrator = context.orm.migrator;
    const applied = await migrator.up();

    expect(applied.length).toBeGreaterThanOrEqual(3);

    const rows = await context.orm.em.getConnection().execute<{ table_name: string }[]>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name in (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        order by table_name`,
      EXPECTED_TABLES,
    );

    expect(rows.map(({ table_name }) => table_name)).toEqual(EXPECTED_TABLES);

    const reverted = await migrator.down({ to: 0 });
    expect(reverted).toHaveLength(applied.length);

    const remaining = await context.orm.em.getConnection().execute<{ table_name: string }[]>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name in (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      EXPECTED_TABLES,
    );

    expect(remaining).toHaveLength(0);

    await migrator.up();
  } finally {
    await context.close();
  }
});
