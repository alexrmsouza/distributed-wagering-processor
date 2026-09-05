import { Global, Module } from '@nestjs/common';

import { getDefaultPrometheusMetrics } from './infrastructure/prometheus-metrics.js';
import { getDefaultRedactingJsonLogger } from './infrastructure/redacting-json.logger.js';
import { OBSERVABILITY_LOGGER, OBSERVABILITY_METRICS } from './observability.tokens.js';
import { MetricsController } from './presentation/metrics.controller.js';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: OBSERVABILITY_LOGGER,
      useFactory: getDefaultRedactingJsonLogger,
    },
    {
      provide: OBSERVABILITY_METRICS,
      useFactory: getDefaultPrometheusMetrics,
    },
  ],
  exports: [OBSERVABILITY_LOGGER, OBSERVABILITY_METRICS],
})
export class ObservabilityModule {}
