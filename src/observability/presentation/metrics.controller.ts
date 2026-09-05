import { Controller, Get, Header, Inject } from '@nestjs/common';

import type { PrometheusMetrics } from '../infrastructure/prometheus-metrics.js';
import { OBSERVABILITY_METRICS } from '../observability.tokens.js';

@Controller('metrics')
export class MetricsController {
  public constructor(@Inject(OBSERVABILITY_METRICS) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  public exposition(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
