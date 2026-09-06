import type { ReadinessProbe } from './ports/readiness-probe.js';

export interface HealthServiceOptions {
  readonly database: ReadinessProbe;
  readonly sqs: ReadinessProbe;
  readonly timeoutMs: number;
}

export interface DependencyHealth {
  readonly status: 'up' | 'down';
}

export interface ReadinessReport {
  readonly status: 'ready' | 'not_ready';
  readonly checks: Readonly<{
    database: DependencyHealth;
    sqs: DependencyHealth;
  }>;
}

export class HealthService {
  readonly #database: ReadinessProbe;
  readonly #sqs: ReadinessProbe;
  readonly #timeoutMs: number;

  public constructor(options: HealthServiceOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new RangeError('Readiness timeout must be a positive safe integer');
    }
    this.#database = options.database;
    this.#sqs = options.sqs;
    this.#timeoutMs = options.timeoutMs;
  }

  public async checkReadiness(): Promise<ReadinessReport> {
    const [database, sqs] = await Promise.all([
      this.checkDependency(this.#database),
      this.checkDependency(this.#sqs),
    ]);
    return Object.freeze({
      status: database.status === 'up' && sqs.status === 'up' ? 'ready' : 'not_ready',
      checks: Object.freeze({ database, sqs }),
    });
  }

  public async onModuleDestroy(): Promise<void> {
    await Promise.all([this.#database.onModuleDestroy?.(), this.#sqs.onModuleDestroy?.()]);
  }

  private async checkDependency(probe: ReadinessProbe): Promise<DependencyHealth> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probe.check(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Readiness probe timed out'));
          }, this.#timeoutMs);
        }),
      ]);
      return Object.freeze({ status: 'up' });
    } catch {
      return Object.freeze({ status: 'down' });
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}
