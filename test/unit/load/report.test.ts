import { describe, expect, test } from 'bun:test';
import { renderReport } from '../../../test/load/report';
import { runFixture, stepFixture } from './run-fixture';

/** The lines of one `## ` section of the report, without its heading. */
function section(report: string, heading: string): string {
  const start = report.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`no section ${heading}`);
  const rest = report.slice(start + heading.length + 3);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

const ONE_CPU = runFixture({
  stackCpus: 1,
  stackCpuList: '0',
  generatorCpuList: '1-3',
  agreedRate: 50,
  steps: [stepFixture({ rate: 50 })],
});
const TWO_CPUS = runFixture({ stackCpus: 2, stackCpuList: '0-1', agreedRate: 100 });

describe('the capacity table', () => {
  test('has one row per run, ordered by the CPUs given to the stack, with the rate per CPU', () => {
    const report = renderReport([TWO_CPUS, ONE_CPU], '2026-10-31T12:00:00.000Z');
    const rows = section(report, 'Capacity by CPU count')
      .split('\n')
      .filter((line) => /^\| \d+ \|/.test(line));
    expect(rows[0]?.startsWith('| 1 | 50 | 50.0 |')).toBe(true);
    expect(rows[1]?.startsWith('| 2 | 100 | 50.0 |')).toBe(true);
  });

  test('computes CPU per request and utilisation at the agreed step, and the ceiling they predict', () => {
    // Net stack use 174% of one CPU over 20.1 s with 2000 answers is 17487 microseconds each.
    // Two CPUs at that cost allow about 114 requests per second, and 100 is 87% of that.
    const report = renderReport([TWO_CPUS], '2026-10-31T12:00:00.000Z');
    const row = section(report, 'Capacity by CPU count')
      .split('\n')
      .find((line) => line.startsWith('| 2 |'));
    expect(row).toContain('| 17487 |');
    expect(row).toContain('| 87% |');
    expect(row).toContain('| 114 |');
  });

  test('says none, and the first failing rate, for a run in which no step passed', () => {
    const failing = runFixture({
      stackCpus: 1,
      stackCpuList: '0',
      agreedRate: null,
      firstFailingRate: 10,
      steps: [stepFixture({ rate: 10, reasons: ['p99 1200.0 ms (max 1000)'] })],
    });
    const report = renderReport([failing], '2026-10-31T12:00:00.000Z');
    expect(section(report, 'Capacity by CPU count')).toContain('| 1 | none |');
    expect(report).toContain('No step passed every constraint');
    expect(report).toContain('p99 1200.0 ms (max 1000)');
  });
});

describe('the detail of each run', () => {
  test('shows a missing value as n/a, never as NaN, null or undefined', () => {
    const sparse = runFixture({
      steps: [
        stepFixture({
          p99: null,
          hotP99: null,
          lagP99Ms: null,
          drainSeconds: null,
          generatorCpuPercent: null,
          lockWaitersMean: null,
        }),
      ],
      agreedRate: null,
      firstFailingRate: 100,
    });
    const report = renderReport([sparse], '2026-10-31T12:00:00.000Z');
    expect(report).toContain('n/a');
    expect(report).not.toContain('NaN');
    expect(report).not.toContain('null');
    expect(report).not.toContain('undefined');
  });

  test('gives the per-kind latency, the incorrect and the concurrent answers of the agreed step', () => {
    const report = renderReport([TWO_CPUS], '2026-10-31T12:00:00.000Z');
    expect(report).toContain('#### Latency by operation at the agreed rate');
    expect(report).toContain('| BET | 900 | 900 | 0 | n/a | 4.0 | 9.0 | 12.0 |');
  });

  test('states the limits of the method, so that a number is never read without them', () => {
    const report = renderReport([TWO_CPUS], '2026-10-31T12:00:00.000Z');
    expect(section(report, 'What these numbers prove, and what they do not')).toContain('one rate');
  });
});
