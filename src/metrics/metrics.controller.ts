import { Controller, Get, Inject } from '@nestjs/common';
import { METRICS_REGISTRY, type MetricsRegistry } from '../shared/observability/metrics';

/**
 * Counters and summaries of this process only. Each replica reports its own numbers.
 * The endpoint carries counts and durations, never payloads or amounts.
 */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly metrics: MetricsRegistry) {}

  @Get()
  snapshot() {
    return this.metrics.snapshot();
  }
}
