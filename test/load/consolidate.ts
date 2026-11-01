/**
 * Consolidates load runs of several scenarios into two tables: one row per run record (cpus-<N>.json)
 * found in each scenario directory. The figures are the ones the committed report computes, from the
 * same helpers (metrics.ts), so a row here matches the report of its run.
 *
 * The first table is the capacity and the CPU of each run. The second is the correctness and latency at the
 * agreed step: errors, violations, incorrect answers, concurrency conflicts, outbox drain and percentiles.
 *
 * Run with `bun run load:consolidate [directory]`. The directory holds one sub-directory per scenario,
 * and defaults to docs/load/local.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cpuMicrosPerRequest, netPercent, utilisation } from './metrics';
import type { RunRecord, StepRecord } from './records';
import { readRuns } from './report';

const root = process.argv[2] ?? `${import.meta.dir}/../../docs/load/local`;

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const fixed = (value: number | null, digits: number): string =>
  value === null ? '-' : value.toFixed(digits);

const names = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const capacityRows: string[] = [
  '| Scenario | APIs | Workers | Stack CPUs | Agreed (req/s) | Per stack CPU (req/s) | CPU µs/req | Utilisation | API CPU % | Worker CPU % | PostgreSQL % | LocalStack % | Largest process RSS (MiB) | First failing (req/s) | Why it failed |',
  '| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --- |',
];
const correctnessRows: string[] = [
  '| Scenario | Error rate (%) | Lost | 5xx | Violations | Duplicates | Incorrect answers | Concurrency conflicts (whole run) | Lock waiters mean / max | Outbox drain (s) | Events created | p50 (ms) | p95 (ms) | p99 (ms) | Generator lag p99 (ms) |',
  '| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |',
];

/** The agreed step of a run, with the rate that passed. Undefined when no step passed. */
function agreedStepOf(run: RunRecord): StepRecord | undefined {
  return run.agreedRate === null
    ? undefined
    : run.steps.find((step) => step.rate === run.agreedRate);
}

/** One row of a table: the cells, joined in markdown. The number of cells must match the header. */
const markdownRow = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;

function capacityRow(name: string, run: RunRecord, agreed: StepRecord | undefined): string {
  const apis = run.environment.topology.match(/^(\d+) API/)?.[1] ?? '?';
  const workers = run.environment.topology.match(/, (\d+) workers?/)?.[1] ?? '?';
  const top = Math.max(...run.steps.map((step) => step.rate));
  const failing = run.steps.find((step) => step.reasons.length > 0);
  const largestRss = Math.max(
    ...run.steps.flatMap((step) => Object.values(step.peakRssMiB)),
  ).toFixed(0);
  const why = failing?.reasons.join('; ').slice(0, 120) ?? '-';
  const identity = [name, apis, workers, run.stackCpus];
  const failure = [run.firstFailingRate ?? '-', why];
  if (agreed === undefined || run.agreedRate === null) {
    return markdownRow([...identity, 'none', ...Array(7).fill('-'), largestRss, ...failure]);
  }
  const net = Object.entries(agreed.cpuPercent).map(
    ([component, gross]) => [component, netPercent(gross, run.idle.cpuPercent[component])] as const,
  );
  const total = sum(net.map(([, value]) => value));
  const group = (prefix: string): string =>
    sum(
      net.filter(([component]) => component.startsWith(prefix)).map(([, value]) => value),
    ).toFixed(0);
  // When no step failed, the agreed rate is the top of the ramp: a floor, not a limit.
  const atTop = failing === undefined && run.agreedRate === top;
  const agreedCell = `${run.agreedRate}${atTop ? ' (ramp top, no limit)' : ''}`;
  const micros = cpuMicrosPerRequest({
    netStackPercent: total,
    elapsedSeconds: agreed.elapsedSeconds,
    answered: agreed.answered,
  }).toFixed(0);
  const util = `${(utilisation({ netStackPercent: total, stackCpus: run.stackCpus }) * 100).toFixed(0)}%`;
  return markdownRow([
    ...identity,
    agreedCell,
    (run.agreedRate / run.stackCpus).toFixed(1),
    micros,
    util,
    group('api-'),
    group('worker-'),
    group('postgres'),
    group('localstack'),
    largestRss,
    ...failure,
  ]);
}

function correctnessRow(name: string, run: RunRecord, agreed: StepRecord | undefined): string {
  if (agreed === undefined) return markdownRow([name, ...Array(14).fill('-')]);
  const incorrect = sum(Object.values(agreed.byKind).map((kind) => kind.unexpected));
  return markdownRow([
    name,
    (agreed.errorRate * 100).toFixed(3),
    agreed.lost,
    agreed.serverErrors,
    agreed.violations,
    agreed.duplicates,
    incorrect,
    run.concurrencyConflicts,
    `${fixed(agreed.lockWaitersMean, 1)} / ${agreed.lockWaitersMax}`,
    fixed(agreed.drainSeconds, 1),
    agreed.eventsCreated,
    fixed(agreed.p50, 1),
    fixed(agreed.p95, 1),
    fixed(agreed.p99, 1),
    fixed(agreed.lagP99Ms, 1),
  ]);
}

for (const name of names) {
  for (const run of await readRuns(join(root, name))) {
    const agreed = agreedStepOf(run);
    capacityRows.push(capacityRow(name, run, agreed));
    correctnessRows.push(correctnessRow(name, run, agreed));
  }
}

console.log(capacityRows.join('\n'));
console.log('');
console.log(correctnessRows.join('\n'));
