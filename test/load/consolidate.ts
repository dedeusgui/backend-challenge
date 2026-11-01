/**
 * Consolidates load runs of several scenarios into one table: one row per run record (cpus-<N>.json)
 * found in each scenario directory. The figures are the ones the committed report computes, from the
 * same helpers (metrics.ts), so a row here matches the report of its run.
 *
 * Run with `bun run load:consolidate [directory]`. The directory holds one sub-directory per scenario,
 * and defaults to docs/load/local.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cpuMicrosPerRequest, netPercent, utilisation } from './metrics';
import { readRuns } from './report';

const root = process.argv[2] ?? `${import.meta.dir}/../../docs/load/local`;

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const names = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const rows: string[] = [
  '| Scenario | APIs | Workers | Stack CPUs | Agreed (req/s) | Per stack CPU (req/s) | CPU µs/req | Utilisation | API CPU % | Worker CPU % | PostgreSQL % | LocalStack % | Largest process RSS (MiB) | First failing (req/s) | Why it failed |',
  '| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --- |',
];

for (const name of names) {
  for (const run of await readRuns(join(root, name))) {
    const apis = run.environment.topology.match(/^(\d+) API/)?.[1] ?? '?';
    const workers = run.environment.topology.match(/, (\d+) workers?/)?.[1] ?? '?';
    const top = Math.max(...run.steps.map((step) => step.rate));
    const failing = run.steps.find((step) => step.reasons.length > 0);
    const agreed =
      run.agreedRate === null ? undefined : run.steps.find((step) => step.rate === run.agreedRate);

    let agreedCell = 'none';
    let perCpu = '-';
    let micros = '-';
    let util = '-';
    let apiCpu = '-';
    let workerCpu = '-';
    let postgresCpu = '-';
    let localstackCpu = '-';
    if (agreed !== undefined && run.agreedRate !== null) {
      const net = Object.entries(agreed.cpuPercent).map(
        ([component, gross]) =>
          [component, netPercent(gross, run.idle.cpuPercent[component])] as const,
      );
      const total = sum(net.map(([, value]) => value));
      const group = (prefix: string): string =>
        sum(
          net.filter(([component]) => component.startsWith(prefix)).map(([, value]) => value),
        ).toFixed(0);
      // When no step failed, the agreed rate is the top of the ramp: a floor, not a limit.
      const atTop = failing === undefined && run.agreedRate === top;
      agreedCell = `${run.agreedRate}${atTop ? ' (ramp top, no limit)' : ''}`;
      perCpu = (run.agreedRate / run.stackCpus).toFixed(1);
      micros = cpuMicrosPerRequest({
        netStackPercent: total,
        elapsedSeconds: agreed.elapsedSeconds,
        answered: agreed.answered,
      }).toFixed(0);
      util = `${(utilisation({ netStackPercent: total, stackCpus: run.stackCpus }) * 100).toFixed(0)}%`;
      apiCpu = group('api-');
      workerCpu = group('worker-');
      postgresCpu = group('postgres');
      localstackCpu = group('localstack');
    }
    const why = failing?.reasons.join('; ').slice(0, 120) ?? '-';
    const largestRss = Math.max(
      ...run.steps.flatMap((step) => Object.values(step.peakRssMiB)),
    ).toFixed(0);
    rows.push(
      `| ${name} | ${apis} | ${workers} | ${run.stackCpus} | ${agreedCell} | ${perCpu} | ${micros} | ${util} | ${apiCpu} | ${workerCpu} | ${postgresCpu} | ${localstackCpu} | ${largestRss} | ${run.firstFailingRate ?? '-'} | ${why} |`,
    );
  }
}

console.log(rows.join('\n'));
