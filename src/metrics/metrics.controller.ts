import { Controller, Get, Header, Inject } from '@nestjs/common';
import { METRICS_REGISTRY, type MetricsRegistry } from '../shared/observability/metrics';
import { OperatorOnly } from '../modules/auth/http/access';
import { toPrometheusText } from '../shared/observability/prometheus-text';

abstract class PrometheusMetricsBaseController {
  protected abstract getMetricsRegistry(): MetricsRegistry;

  @Get('prometheus')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  prometheus(): string {
    return toPrometheusText(this.getMetricsRegistry().snapshot());
  }
}

/**
 * Counters and summaries of this process only. Each replica reports its own numbers.
 * The endpoint carries counts and durations, never payloads or amounts.
 */
@OperatorOnly()
@Controller('metrics')
export class MetricsController extends PrometheusMetricsBaseController {
  constructor(@Inject(METRICS_REGISTRY) private readonly metrics: MetricsRegistry) {
    super();
  }

  protected getMetricsRegistry(): MetricsRegistry {
    return this.metrics;
  }

  @Get()
  snapshot() {
    return this.metrics.snapshot();
  }
}
