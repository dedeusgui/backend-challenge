import { describe, expect, test } from 'bun:test';
import {
  countersOfBody,
  summariesOfBody,
  cpuMicrosPerRequest,
  formatCpuList,
  mergeSummaries,
  netPercent,
  parseCpuList,
  parseCpuListOrNone,
  parseDockerStats,
  parsePidTable,
  parseProcStatRssKiB,
  parseProcStatTicks,
  percentile,
  predictedCeiling,
  stripTerminalCodes,
  summariesFromOutput,
  utilisation,
} from '../../../test/load/metrics';

describe('percentile', () => {
  test('takes the nearest rank of a sorted sample', () => {
    const sample = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(sample, 0.5)).toBe(50);
    expect(percentile(sample, 0.99)).toBe(99);
    expect(percentile(sample, 1)).toBe(100);
  });

  test('is not a number for an empty sample, so that it is reported as missing', () => {
    expect(percentile([], 0.99)).toBeNaN();
  });
});

describe('CPU lists', () => {
  test('parses ranges and single ids, as /proc and taskset write them', () => {
    expect(parseCpuList('0-2,5')).toEqual([0, 1, 2, 5]);
    expect(parseCpuList('3')).toEqual([3]);
  });

  test('formats ids back as the shortest list taskset accepts', () => {
    expect(formatCpuList([0, 1, 2, 3])).toBe('0-3');
    expect(formatCpuList([0, 2])).toBe('0,2');
    expect(formatCpuList(parseCpuList('0-2,5'))).toBe('0-2,5');
  });

  test('refuses text that is not a list, rather than pinning to the wrong CPUs', () => {
    expect(() => parseCpuList('0-x')).toThrow();
  });

  test('reads an empty list as no CPUs, which is what a generator with none left has', () => {
    expect(parseCpuListOrNone('')).toEqual([]);
    expect(parseCpuListOrNone('2-3')).toEqual([2, 3]);
    expect(() => parseCpuListOrNone('x')).toThrow();
  });
});

describe('reading the CPU and memory of a process', () => {
  test('adds user and system ticks from /proc/<pid>/stat, whose command name may hold spaces', () => {
    // Fields after the closing parenthesis start at the state. utime is field 14 and stime is 15.
    const stat = '1234 (bun run src) S 1 1234 1234 0 -1 4194560 1000 0 0 0 250 50 0 0 20 0 9 0 1';
    expect(parseProcStatTicks(stat)).toBe(300);
  });

  test('reads a two-column table of ps output, one process per line', () => {
    const table = parsePidTable('  123   4096\n  456   2048\n');
    expect(table.get(123)).toBe(4096);
    expect(table.get(456)).toBe(2048);
    expect(table.size).toBe(2);
  });

  test('reads docker stats lines and ignores the rows that have no value', () => {
    const stats = parseDockerStats(
      'backend-challenge-postgres-1\t12.50%\nbackend-challenge-localstack-1\t3.10%\nx\t--\n',
    );
    expect(stats.get('backend-challenge-postgres-1')).toBe(12.5);
    expect(stats.get('backend-challenge-localstack-1')).toBe(3.1);
    expect(stats.has('x')).toBe(false);
  });
});

describe('reading a streamed docker stats line', () => {
  test('strips the cursor codes that docker writes even when its output is not a terminal', () => {
    const streamed = '\u001b[Hbackend-challenge-postgres-1\t0.30%\u001b[K\n\u001b[K\n\u001b[J';
    const stats = parseDockerStats(stripTerminalCodes(streamed));
    expect(stats.get('backend-challenge-postgres-1')).toBe(0.3);
    expect(stats.size).toBe(1);
  });
});

describe('reading the resident memory of a process', () => {
  test('takes VmRSS, in KiB, from /proc/<pid>/status', () => {
    const status = 'Name:\tbun\nVmPeak:\t  900000 kB\nVmRSS:\t  124416 kB\nThreads:\t9\n';
    expect(parseProcStatRssKiB(status)).toBe(124416);
  });

  test('is undefined when the status has no resident figure', () => {
    expect(parseProcStatRssKiB('Name:\tbun\n')).toBeUndefined();
  });
});

describe('CPU per request', () => {
  test('a component never gets credit for less CPU than its idle baseline', () => {
    expect(netPercent(50, 10)).toBe(40);
    expect(netPercent(5, 10)).toBe(0);
    expect(netPercent(50, undefined)).toBe(50);
  });

  test('is the CPU the stack used beyond its idle baseline, divided by the requests it answered', () => {
    // 40% of one CPU for the API plus 80% for PostgreSQL is 120% of one CPU, held for 10 s:
    // 12 CPU-seconds. Over 10,000 answered requests that is 1200 microseconds of CPU each.
    expect(
      cpuMicrosPerRequest({ netStackPercent: 120, elapsedSeconds: 10, answered: 10_000 }),
    ).toBe(1200);
  });

  test('is not a number when nothing was answered', () => {
    expect(
      cpuMicrosPerRequest({ netStackPercent: 120, elapsedSeconds: 10, answered: 0 }),
    ).toBeNaN();
  });

  test('utilisation is the share of the CPUs given to the stack that the stack used', () => {
    expect(utilisation({ netStackPercent: 200, stackCpus: 4 })).toBe(0.5);
  });

  test('the predicted ceiling is the rate at which the stack would use every CPU it has', () => {
    // 2 CPUs and 1200 microseconds per request allow 2e6 / 1200 requests per second.
    expect(predictedCeiling({ stackCpus: 2, cpuMicros: 1200 })).toBeCloseTo(1666.67, 1);
  });
});

describe('mergeSummaries', () => {
  test('adds the counts and the sums of several processes, and keeps the largest maximum', () => {
    const merged = mergeSummaries([
      { transaction_work_ms: { count: 2, sum: 10, max: 7 } },
      { transaction_work_ms: { count: 3, sum: 30, max: 12 } },
    ]);

    expect(merged).toEqual({ transaction_work_ms: { count: 5, mean: 8, max: 12, unit: 'ms' } });
  });

  test('keeps a name that only one process reported', () => {
    const merged = mergeSummaries([
      { auth_ms: { count: 1, sum: 2, max: 2 } },
      { settlement_ms: { count: 4, sum: 8, max: 3 } },
    ]);

    expect(Object.keys(merged).sort()).toEqual(['auth_ms', 'settlement_ms']);
    expect(merged['settlement_ms']).toEqual({ count: 4, mean: 2, max: 3, unit: 'ms' });
  });
});

describe('summariesFromOutput', () => {
  test('reads the summaries of the last metrics line a worker printed on its graceful stop', () => {
    const output = [
      '{"time":"t","level":"info","operation":"command.settle","status":"APPLIED"}',
      '{"time":"t","type":"metrics","counters":{},"summaries":{"outbox_publish_ms":{"count":2,"sum":5,"max":4}}}',
      '',
    ].join('\n');

    expect(summariesFromOutput(output)).toEqual({
      outbox_publish_ms: { count: 2, sum: 5, max: 4 },
    });
  });

  test('is undefined when the worker printed no metrics line, or a malformed one', () => {
    expect(
      summariesFromOutput('{"type":"metrics","summaries":{"x":{"count":"2"}}}'),
    ).toBeUndefined();
    expect(summariesFromOutput('plain text only\n')).toBeUndefined();
  });
});

describe('the metrics endpoint answer', () => {
  test('its counters and summaries are read, and a missing counter set is an error, not zero', () => {
    const body = {
      counters: { 'transactions_total{status="PROCESSED"}': 3 },
      summaries: { auth_ms: { count: 3, sum: 6, max: 4 } },
    };

    expect(countersOfBody(body)).toEqual({ 'transactions_total{status="PROCESSED"}': 3 });
    expect(summariesOfBody(body)).toEqual({ auth_ms: { count: 3, sum: 6, max: 4 } });
    expect(() => countersOfBody({ summaries: {} })).toThrow('without counters');
    expect(summariesOfBody({ counters: {} })).toBeUndefined();
  });
});
