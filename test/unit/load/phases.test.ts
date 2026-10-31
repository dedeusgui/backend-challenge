import { describe, expect, test } from 'bun:test';
import { mergeSummaries, readPhaseSummary, unitOfSummary } from '../../../test/load/metrics';
import { renderReport } from '../../../test/load/report';
import { runFixture, stepFixture } from './run-fixture';

/**
 * The summaries the workers and the API report, and the unit each one is in. The unit comes from the name the
 * code gives the summary, so a value in seconds can never be labelled as milliseconds. Runs were written with
 * the field names meanMs and maxMs for every summary, and seconds were stored under them. They stay readable,
 * with the unit their name gives.
 */

describe('the unit of a summary comes from its name', () => {
  test('a name ending in _seconds is in seconds, and one ending in _ms is in milliseconds', () => {
    expect(unitOfSummary('outbox_lag_seconds')).toBe('s');
    expect(unitOfSummary('outbox_publish_ms')).toBe('ms');
  });

  test('a name with neither suffix is refused, so no unit is ever guessed', () => {
    expect(() => unitOfSummary('outbox_lag')).toThrow('has no unit in its name');
  });
});

describe('merging the summaries of several processes', () => {
  test('the mean is taken over every observation together, and the unit is the one of the name', () => {
    const merged = mergeSummaries([
      { outbox_lag_seconds: { count: 2, sum: 1, max: 0.8 } },
      { outbox_lag_seconds: { count: 6, sum: 2, max: 0.5 } },
    ]);
    expect(merged).toEqual({ outbox_lag_seconds: { count: 8, mean: 0.375, max: 0.8, unit: 's' } });
  });

  test('a summary in milliseconds keeps its unit', () => {
    const merged = mergeSummaries([{ outbox_publish_ms: { count: 2, sum: 5, max: 4 } }]);
    expect(merged).toEqual({ outbox_publish_ms: { count: 2, mean: 2.5, max: 4, unit: 'ms' } });
  });
});

describe('reading a stored summary', () => {
  test('a run written before the unit was recorded reads its seconds as seconds, from the name', () => {
    const stored = { count: 12424, meanMs: 0.1988590631036706, maxMs: 1.009 };
    expect(readPhaseSummary('outbox_lag_seconds', stored)).toEqual({
      count: 12424,
      mean: 0.1988590631036706,
      max: 1.009,
      unit: 's',
    });
  });

  test('a current summary reads back unchanged', () => {
    const current = { count: 3, mean: 2.5, max: 4, unit: 'ms' as const };
    expect(readPhaseSummary('outbox_publish_ms', current)).toEqual(current);
  });

  test('a summary of the wrong shape is refused', () => {
    expect(() => readPhaseSummary('outbox_publish_ms', { count: 1 })).toThrow();
  });
});

describe('the report shows the outbox lag and the drain, each in its unit', () => {
  const run = runFixture({
    stackCpus: 1,
    stackCpuList: '0',
    agreedRate: 100,
    steps: [stepFixture({ rate: 100, drainSeconds: 0.4, lagP99Ms: 1.2, maxLagMs: 2 })],
    phases: {
      outbox_lag_seconds: { count: 12424, mean: 0.199, max: 1.009, unit: 's' },
      outbox_publish_ms: { count: 1331, mean: 18.7, max: 543.1, unit: 'ms' },
    },
  });

  test('the outbox lag is printed in seconds, with its count, mean and maximum, and no percentile', () => {
    const report = renderReport([run], '2026-10-31T12:00:00.000Z');
    expect(report).toContain('| Outbox lag, commit to send | s | 12424 | 0.199 | 1.009 |');
    expect(report).toContain('| Outbox publish, one claimed batch | ms | 1331 | 18.7 | 543.1 |');
    expect(report).toContain('no percentile of the outbox lag is measured');
  });

  test('the drain at the agreed step is in seconds, and the generator lag in milliseconds', () => {
    const report = renderReport([run], '2026-10-31T12:00:00.000Z');
    expect(report).toContain('| Outbox drain after the step | s | 0.400 |');
    expect(report).toContain('| Generator lag, p99 | ms | 1.2 |');
  });
});
