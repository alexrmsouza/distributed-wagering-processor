import { Controller, Get, HttpException } from '@nestjs/common';

import { HealthService } from '../application/health.service.js';

@Controller('health')
export class HealthController {
  public constructor(private readonly healthService: HealthService) {}

  @Get('live')
  public liveness() {
    return Object.freeze({ status: 'ok' as const });
  }

  @Get('ready')
  public async readiness() {
    const report = await this.healthService.checkReadiness();
    if (report.status === 'not_ready') {
      throw new HttpException(report, 503);
    }
    return report;
  }
}
