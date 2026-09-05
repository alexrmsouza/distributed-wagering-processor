import { RequestContext, type EntityManager } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';

import type { TransactionRunner } from '../application/transaction-runner.js';

export type MikroOrmTransactionContextFactory<TContext> = (
  entityManager: EntityManager,
) => TContext;

export class MikroOrmRequestContextAdapter {
  public constructor(private readonly orm: MikroORM) {}

  public run<TResult>(work: () => Promise<TResult>): Promise<TResult> {
    return RequestContext.create(this.orm.em, work);
  }
}

export class MikroOrmTransactionRunner<TContext> implements TransactionRunner<TContext> {
  private readonly requestContext: MikroOrmRequestContextAdapter;

  public constructor(
    private readonly orm: MikroORM,
    private readonly createContext: MikroOrmTransactionContextFactory<TContext>,
    requestContext?: MikroOrmRequestContextAdapter,
  ) {
    this.requestContext = requestContext ?? new MikroOrmRequestContextAdapter(orm);
  }

  public run<TResult>(work: (context: TContext) => Promise<TResult>): Promise<TResult> {
    return this.requestContext.run(() =>
      this.orm.em.transactional(async (entityManager) => work(this.createContext(entityManager))),
    );
  }
}
