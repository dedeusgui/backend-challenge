import { describe, expect, test } from 'bun:test';
import { toPrometheusText } from '../../../src/shared/observability/prometheus-text';
import { MetricsController } from '../../../src/metrics/metrics.controller';
import { MetricsRegistry } from '../../../src/shared/observability/metrics';

describe('toPrometheusText', () => {
  test('formats a snapshot with a labelled counter and a summary to Prometheus exposition text', () => {
    const snapshot = {
      counters: {
        'transactions_total{status="PROCESSED"}': 2,
      },
      summaries: {
        processing_latency_ms: { count: 3, sum: 60, max: 25 },
      },
    };

    const expected =
      [
        '# TYPE transactions_total counter',
        'transactions_total{status="PROCESSED"} 2',
        '# TYPE processing_latency_ms summary',
        'processing_latency_ms_sum 60',
        'processing_latency_ms_count 3',
      ].join('\n') + '\n';

    expect(toPrometheusText(snapshot)).toBe(expected);
  });

  test('formats unlabelled counters and labelled summaries', () => {
    const snapshot = {
      counters: {
        idempotent_replays_total: 1,
      },
      summaries: {
        'replay_latency_ms{path="replay"}': { count: 2, sum: 10, max: 6 },
      },
    };

    const expected =
      [
        '# TYPE idempotent_replays_total counter',
        'idempotent_replays_total 1',
        '# TYPE replay_latency_ms summary',
        'replay_latency_ms_sum{path="replay"} 10',
        'replay_latency_ms_count{path="replay"} 2',
      ].join('\n') + '\n';

    expect(toPrometheusText(snapshot)).toBe(expected);
  });

  test('groups multiple series under a single # TYPE declaration', () => {
    const snapshot = {
      counters: {
        'transactions_total{status="PROCESSED"}': 2,
        'transactions_total{status="REJECTED"}': 1,
      },
      summaries: {},
    };

    const expected =
      [
        '# TYPE transactions_total counter',
        'transactions_total{status="PROCESSED"} 2',
        'transactions_total{status="REJECTED"} 1',
      ].join('\n') + '\n';

    expect(toPrometheusText(snapshot)).toBe(expected);
  });

  test('returns empty string when registry has no metrics', () => {
    expect(toPrometheusText({ counters: {}, summaries: {} })).toBe('');
  });
});

describe('MetricsController', () => {
  test('prometheus endpoint returns formatted Prometheus text', () => {
    const registry = new MetricsRegistry();
    registry.increment('transactions_total', { status: 'PROCESSED' });
    const controller = new MetricsController(registry);

    expect(controller.prometheus()).toBe(
      '# TYPE transactions_total counter\ntransactions_total{status="PROCESSED"} 1\n',
    );
  });
});
