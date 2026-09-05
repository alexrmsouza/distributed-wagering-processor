import type { FailpointControlPort, FailpointName, FailpointPort } from './failpoint.port.js';

export interface FailpointConfiguration {
  readonly enabled: boolean;
  readonly environment: string;
}

export class FailpointTriggeredError extends Error {
  public constructor(public readonly failpoint: FailpointName) {
    super(`Failpoint triggered: ${failpoint}`);
    this.name = 'FailpointTriggeredError';
  }
}

export class FailpointController implements FailpointPort, FailpointControlPort {
  readonly #armed = new Set<FailpointName>();

  private constructor(configuration: FailpointConfiguration) {
    if (configuration.environment !== 'test') {
      throw new Error('Failpoints are only available in test environments');
    }
    if (!configuration.enabled) {
      throw new Error('Failpoints are disabled');
    }
  }

  public static create(configuration: FailpointConfiguration): FailpointController {
    return new FailpointController(configuration);
  }

  public arm(name: FailpointName): void {
    this.#armed.add(name);
  }

  public disarm(name: FailpointName): void {
    this.#armed.delete(name);
  }

  public disarmAll(): void {
    this.#armed.clear();
  }

  public trigger(name: FailpointName): Promise<void> {
    if (!this.#armed.delete(name)) {
      return Promise.resolve();
    }

    return Promise.reject(new FailpointTriggeredError(name));
  }
}
