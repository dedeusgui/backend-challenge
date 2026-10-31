import { describe, expect, test } from 'bun:test';
import { MetricsRegistry } from '../../../src/shared/observability/metrics';

describe('MetricsRegistry', () => {
  test('counts increments per name and label set', () => {
    const metrics = new MetricsRegistry();

    metrics.increment('transactions_total', { status: 'PROCESSED' });
    metrics.increment('transactions_total', { status: 'PROCESSED' });
    metrics.increment('transactions_total', { status: 'REJECTED' });

    expect(metrics.snapshot().counters).toEqual({
      'transactions_total{status="PROCESSED"}': 2,
      'transactions_total{status="REJECTED"}': 1,
    });
  });

  test('summarizes observations as count, sum and max', () => {
    const metrics = new MetricsRegistry();

    metrics.observe('processing_latency_ms', 10);
    metrics.observe('processing_latency_ms', 30);

    expect(metrics.snapshot().summaries).toEqual({
      processing_latency_ms: { count: 2, sum: 40, max: 30 },
    });
  });

  test('summarizes labelled observations per label set, as counters do', () => {
    const metrics = new MetricsRegistry();

    metrics.observe('replay_latency_ms', 4, { path: 'replay' });
    metrics.observe('replay_latency_ms', 6, { path: 'replay' });
    metrics.observe('replay_latency_ms', 9, { path: 'new' });

    expect(metrics.snapshot().summaries).toEqual({
      'replay_latency_ms{path="replay"}': { count: 2, sum: 10, max: 6 },
      'replay_latency_ms{path="new"}': { count: 1, sum: 9, max: 9 },
    });
  });

  test('a fresh registry starts empty, so processes never share counts', () => {
    const first = new MetricsRegistry();
    first.increment('idempotent_replays_total');

    expect(new MetricsRegistry().snapshot().counters).toEqual({});
  });
});
