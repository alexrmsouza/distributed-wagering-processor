import { randomUUID } from 'node:crypto';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestEnvironment } from './test-environment.js';

export interface DatabaseTestContext {
  readonly databaseName: string;
  readonly orm: MikroORM;
  close(): Promise<void>;
}

function assertSafeDatabaseName(databaseName: string): void {
  if (!/^[a-z][a-z0-9_]+$/.test(databaseName)) {
    throw new Error('Unsafe test database name');
  }
}

export async function createDatabaseTestContext(prefix: string): Promise<DatabaseTestContext> {
  const databaseName = `${prefix}_${randomUUID().replaceAll('-', '')}`.toLowerCase();
  assertSafeDatabaseName(databaseName);

  const testEnvironment = createTestEnvironment();
  for (const [key, value] of Object.entries(testEnvironment.variables)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  const { createMikroOrmConfig } =
    await import('../../src/bootstrap/configuration/mikro-orm.config.js');
  const baseEnvironment = testEnvironment.configuration;
  const adminEnvironment = Object.freeze({ ...baseEnvironment, DATABASE_NAME: 'postgres' });
  const adminOrm = await MikroORM.init(createMikroOrmConfig(adminEnvironment));

  try {
    await adminOrm.em.getConnection().execute(`create database "${databaseName}"`);
  } finally {
    await adminOrm.close(true);
  }

  const databaseEnvironment = Object.freeze({ ...baseEnvironment, DATABASE_NAME: databaseName });
  const orm = await MikroORM.init(createMikroOrmConfig(databaseEnvironment));

  return {
    databaseName,
    orm,
    async close(): Promise<void> {
      await orm.close(true);

      const cleanupOrm = await MikroORM.init(createMikroOrmConfig(adminEnvironment));
      try {
        await cleanupOrm.em.getConnection().execute(
          `select pg_terminate_backend(pid)
             from pg_stat_activity
            where datname = ? and pid <> pg_backend_pid()`,
          [databaseName],
        );
        await cleanupOrm.em.getConnection().execute(`drop database if exists "${databaseName}"`);
      } finally {
        await cleanupOrm.close(true);
      }
    },
  };
}
