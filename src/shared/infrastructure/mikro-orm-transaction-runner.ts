import { RequestContext, type EntityManager } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';

import type { TransactionRunner } from '../application/transaction-runner.js';

export type MikroOrmTransactionContextFactory<TContext> = (
  entityManager: EntityManager,
) => TContext;

const TRANSIENT_POSTGRESQL_STATES = new Set(['40001', '40P01', '55P03']);
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 25;
const MAX_ERROR_DEPTH = 8;

export interface MikroOrmTransactionRunnerOptions {
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

interface ErrorRecord {
  readonly code?: unknown;
  readonly cause?: unknown;
  readonly originalError?: unknown;
  readonly driverException?: unknown;
}

function assertBoundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be a safe integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
}

function isErrorRecord(value: unknown): value is ErrorRecord {
  return typeof value === 'object' && value !== null;
}

function isTransientPostgresqlError(error: unknown): boolean {
  const visited = new Set<object>();
  let frontier: readonly unknown[] = [error];

  for (let depth = 0; depth < MAX_ERROR_DEPTH && frontier.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const candidate of frontier) {
      if (!isErrorRecord(candidate) || visited.has(candidate)) {
        continue;
      }
      visited.add(candidate);
      if (typeof candidate.code === 'string' && TRANSIENT_POSTGRESQL_STATES.has(candidate.code)) {
        return true;
      }
      next.push(candidate.cause, candidate.originalError, candidate.driverException);
    }
    frontier = next;
  }

  return false;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class MikroOrmRequestContextAdapter {
  public constructor(private readonly orm: MikroORM) {}

  public run<TResult>(work: () => Promise<TResult>): Promise<TResult> {
    return RequestContext.create(this.orm.em, work);
  }
}

export class MikroOrmTransactionRunner<TContext> implements TransactionRunner<TContext> {
  private readonly requestContext: MikroOrmRequestContextAdapter;
  readonly #lockTimeoutMs: number;
  readonly #statementTimeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryBaseDelayMs: number;
  readonly #sleep: (delayMs: number) => Promise<void>;

  public constructor(
    private readonly orm: MikroORM,
    private readonly createContext: MikroOrmTransactionContextFactory<TContext>,
    requestContext?: MikroOrmRequestContextAdapter,
    options: MikroOrmTransactionRunnerOptions = {},
  ) {
    this.requestContext = requestContext ?? new MikroOrmRequestContextAdapter(orm);
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.#sleep = options.sleep ?? defaultSleep;

    assertBoundedInteger(this.#lockTimeoutMs, 'lockTimeoutMs', 1, 300_000);
    assertBoundedInteger(this.#statementTimeoutMs, 'statementTimeoutMs', 1, 900_000);
    assertBoundedInteger(this.#maxAttempts, 'maxAttempts', 1, 5);
    assertBoundedInteger(this.#retryBaseDelayMs, 'retryBaseDelayMs', 0, 1_000);
    if (this.#statementTimeoutMs <= this.#lockTimeoutMs) {
      throw new RangeError('statementTimeoutMs must be greater than lockTimeoutMs');
    }
  }

  public async run<TResult>(work: (context: TContext) => Promise<TResult>): Promise<TResult> {
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        return await this.runAttempt(work);
      } catch (error: unknown) {
        if (attempt === this.#maxAttempts || !isTransientPostgresqlError(error)) {
          throw error;
        }
        await this.#sleep(this.#retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    throw new Error('Transaction attempts were exhausted');
  }

  private runAttempt<TResult>(work: (context: TContext) => Promise<TResult>): Promise<TResult> {
    return this.requestContext.run(() =>
      this.orm.em.transactional(async (entityManager) => {
        const connection = entityManager.getConnection();
        await connection.execute(
          "select set_config('lock_timeout', ?, true)",
          [`${String(this.#lockTimeoutMs)}ms`],
          'all',
          entityManager.getTransactionContext(),
        );
        await connection.execute(
          "select set_config('statement_timeout', ?, true)",
          [`${String(this.#statementTimeoutMs)}ms`],
          'all',
          entityManager.getTransactionContext(),
        );
        return work(this.createContext(entityManager));
      }),
    );
  }
}
