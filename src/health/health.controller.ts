import { Controller, Get, Inject, Res } from '@nestjs/common';
import { HEALTH_SERVICE, type ReadinessProbe, type ReadinessReport } from './health.service';
import { Public } from '../modules/auth/http/access';
import type { StatusSetter } from '../shared/http/status-setter';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(HEALTH_SERVICE) private readonly health: ReadinessProbe) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<{ status: 'ok' | 'unavailable'; checks: ReadinessReport['checks'] }> {
    const report = await this.health.ready();
    response.status(report.ready ? 200 : 503);
    return { status: report.ready ? 'ok' : 'unavailable', checks: report.checks };
  }
}
