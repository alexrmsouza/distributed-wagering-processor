import { createCorrelationContext } from '../../shared/application/correlation-context.js';
import {
  FailpointTriggeredError,
  type FailpointName,
  type FailpointPort,
} from '../../shared/application/failpoints/failpoint.port.js';
import type { OperationalLogger } from './operational-logger.js';
import type { OperationalMetrics } from './operational-metrics.js';

export interface ObservableFailpointDependencies {
  readonly failpoints: FailpointPort;
  readonly logger: OperationalLogger;
  readonly metrics: OperationalMetrics;
  readonly instanceId: string;
}

export class ObservableFailpointPort implements FailpointPort {
  public constructor(private readonly dependencies: ObservableFailpointDependencies) {}

  public async trigger(name: FailpointName): Promise<void> {
    try {
      await this.dependencies.failpoints.trigger(name);
    } catch (error: unknown) {
      if (error instanceof FailpointTriggeredError) {
        try {
          this.dependencies.metrics.recordFailpoint(name);
        } catch {
          // Observability must not replace the deterministic failpoint outcome.
        }
        try {
          this.dependencies.logger.info(
            'failpoint_activated',
            createCorrelationContext({ correlationId: this.dependencies.instanceId }),
            { failpoint: name, stage: name },
          );
        } catch {
          // Observability must not replace the deterministic failpoint outcome.
        }
      }
      throw error;
    }
  }
}
