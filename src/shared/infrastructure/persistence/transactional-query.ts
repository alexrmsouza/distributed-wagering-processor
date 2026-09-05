import type { EntityManager } from '@mikro-orm/core';

export async function queryRows<TRow extends object>(
  entityManager: EntityManager,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<TRow[]> {
  const rows: unknown = await entityManager
    .getConnection()
    .execute<TRow[]>(sql, [...parameters], 'all', entityManager.getTransactionContext());

  return rows as TRow[];
}

export async function executeStatement(
  entityManager: EntityManager,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<void> {
  await entityManager
    .getConnection()
    .execute(sql, [...parameters], 'run', entityManager.getTransactionContext());
}
