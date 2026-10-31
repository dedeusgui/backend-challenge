import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRuns } from '../../../test/load/report';
import { stepReasons } from '../../../test/load/judgement';
import { WORKLOAD_KINDS } from '../../../test/load/workload';
import type { RunRecord, StepRecord } from '../../../test/load/records';

/**
 * The committed runs were judged before the judgement of answers was counted this way. This checks that the
 * judgement of today gives every step that passed then the same verdict now, and that each agreed rate is a
 * step that passes. A rule that fails a step that passed would move the agreed rates, and this test would say so.
 */

const RESULTS_DIR = join(import.meta.dir, '../../../docs/load/results');

function incorrectOf(step: StepRecord) {
  return WORKLOAD_KINDS.flatMap((kind) => {
    const row = step.byKind[kind];
    if (row === undefined || row.unexpected === 0) return [];
    return [{ kind, status: 0, count: row.unexpected }];
  });
}

describe('the committed runs keep their verdicts under the current judgement', () => {
  test('every step that passed when it was measured still passes', async () => {
    const runs: RunRecord[] = await readRuns(RESULTS_DIR);
    expect(runs.length).toBe(3);
    for (const run of runs) {
      for (const step of run.steps) {
        if (step.reasons.length !== 0) continue;
        const reasons = stepReasons({
          lost: step.lost,
          errorRate: step.errorRate,
          p95: step.p95 ?? Number.NaN,
          p99: step.p99 ?? Number.NaN,
          lagP99Ms: step.lagP99Ms ?? Number.NaN,
          drainSeconds: step.drainSeconds,
          violations: step.violations,
          duplicates: step.duplicates,
          incorrect: incorrectOf(step),
          peakRssMiB: step.peakRssMiB,
        });
        expect({ cpus: run.stackCpus, rate: step.rate, reasons }).toEqual({
          cpus: run.stackCpus,
          rate: step.rate,
          reasons: [],
        });
      }
    }
  });

  test('each agreed rate is a step that passes, and the first failing step fails', async () => {
    const runs = await readRuns(RESULTS_DIR);
    for (const run of runs) {
      const agreed = run.steps.find((step) => step.rate === run.agreedRate);
      expect(agreed?.reasons).toEqual([]);
      const failing = run.steps.find((step) => step.rate === run.firstFailingRate);
      expect((failing?.reasons.length ?? 0) > 0).toBe(run.firstFailingRate !== null);
    }
  });

  test('the committed result files are the ones this test reads', async () => {
    const files = (await readdir(RESULTS_DIR)).filter((name) => /^cpus-\d+\.json$/.test(name));
    expect(files.sort()).toEqual(['cpus-1.json', 'cpus-2.json', 'cpus-4.json']);
    const first = JSON.parse(await readFile(join(RESULTS_DIR, 'cpus-1.json'), 'utf8')) as {
      format: string;
    };
    expect(first.format).toBe('load-test-run');
  });
});
