/**
 * Load test, an optional differential of the challenge (section 14).
 *
 * It runs the real stack as independent processes: three API processes and two workers, sharing one
 * PostgreSQL and one LocalStack. Requests are sent on a schedule, at a fixed rate per step (an open
 * model): the next request is sent when its time comes, whether or not the previous one has answered.
 * Latency is measured from the scheduled time, so a slow system cannot hide its queue by slowing the
 * sender (coordinated omission).
 *
 * Each step is checked against LOAD_THRESHOLDS: errors, lost requests, latency, generator lag, outbox
 * drain, memory, and the invariant `wallet.balance == ledger` for every wallet. The ramp stops at the
 * first failing step. The agreed rate is the highest step that passed. The report is written to
 * docs/LOAD_TEST_RESULTS.md, with its limits.
 *
 * Run with `bun run test:load`. It is not part of `check:all`. Its numbers describe the machine that
 * runs it. For a quick check, set LOAD_RATES=25,50 and LOAD_STEP_SECONDS=3.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { CreateApiClient } from '../../src/modules/auth/application/create-api-client.use-case';
import { MikroOrmApiClientRepository } from '../../src/modules/auth/infrastructure/mikro-orm-api-client.repository';
import { ProcessCluster, type ManagedProcess } from '../concurrency/support/process-cluster';
import { LOAD_THRESHOLDS } from './thresholds';

const RATES: readonly number[] = process.env.LOAD_RATES
  ? process.env.LOAD_RATES.split(',').map(Number)
  : LOAD_THRESHOLDS.stepRatesPerSecond;
const STEP_SECONDS = Number(process.env.LOAD_STEP_SECONDS ?? LOAD_THRESHOLDS.stepSeconds);
const REPORT_PATH = `${import.meta.dir}/../../docs/LOAD_TEST_RESULTS.md`;
const DRAIN_CAP_SECONDS = 120;

type Outcome = number | 'LOST';

interface Operation {
  key: string;
  body: string;
  hot: boolean;
  replay: boolean;
}

interface Sample {
  latencyMs: number;
  outcome: Outcome;
  hot: boolean;
  /** For a lost request: the error class and its message. Never a payload. */
  lostReason?: string;
}

interface StepReport {
  rate: number;
  seconds: number;
  sent: number;
  answered: number;
  lost: number;
  serverErrors: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  hotP99: number;
  distinctP99: number;
  /** CPU use of each stack process during the step, as a percent of one CPU. */
  cpuPercent: Map<string, number>;
  /** CPU use of the load generator itself, as a percent of one CPU. */
  generatorCpuPercent: number;
  containerCpuPercent: Map<string, number>;
  lostReasons: Map<string, number>;
  maxLagMs: number;
  lagP99Ms: number;
  drainSeconds: number;
  violations: number;
  duplicates: number;
  peakRssMiB: Map<string, number>;
  statusMix: Map<string, number>;
  reasons: string[];
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] as number;
}

/** Clock ticks per second on Linux, where /proc reports CPU time. */
const LINUX_CLOCK_TICKS = 100;

/**
 * Cumulative CPU seconds of each process. On Linux the exact figure comes from /proc/<pid>/stat, in
 * clock ticks. Elsewhere it comes from ps, in whole seconds. A process that cannot be read is absent.
 */
async function cpuSecondsOf(pids: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  const fromProc = await Promise.all(
    pids.map(async (pid) => {
      try {
        const stat = await Bun.file(`/proc/${pid}/stat`).text();
        // The command name is in parentheses and may contain spaces. The fields after it start at state.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ticks = Number(fields[11]) + Number(fields[12]);
        return Number.isFinite(ticks) ? ([pid, ticks / LINUX_CLOCK_TICKS] as const) : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  for (const entry of fromProc) {
    if (entry !== undefined) result.set(entry[0], entry[1]);
  }
  if (result.size > 0) return result;

  const child = Bun.spawn(['ps', '-o', 'pid=,cputimes=', '-p', pids.join(',')], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const text = await new Response(child.stdout).text();
  await child.exited;
  for (const line of text.split('\n')) {
    const [pid, seconds] = line.trim().split(/\s+/).map(Number);
    if (
      pid !== undefined &&
      seconds !== undefined &&
      Number.isFinite(pid) &&
      Number.isFinite(seconds)
    ) {
      result.set(pid, seconds);
    }
  }
  return result;
}

/** CPU percent of each infrastructure container, from docker stats. Empty when Docker is not available. */
async function containerCpuSample(): Promise<Map<string, number>> {
  try {
    const child = Bun.spawn(
      ['docker', 'stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}'],
      {
        stdout: 'pipe',
        stderr: 'ignore',
      },
    );
    const text = await new Response(child.stdout).text();
    await child.exited;
    const result = new Map<string, number>();
    for (const line of text.split('\n')) {
      const [name, cpu] = line.split('\t');
      const value = Number.parseFloat(cpu ?? '');
      if (name !== undefined && Number.isFinite(value)) result.set(name, value);
    }
    return result;
  } catch {
    return new Map();
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(200);
  }
  return false;
}

/** Resident memory in MiB of each process, from `ps`. Works on Linux and macOS. */
async function rssMiBOf(pids: number[]): Promise<Map<number, number>> {
  const child = Bun.spawn(['ps', '-o', 'pid=,rss=', '-p', pids.join(',')], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const text = await new Response(child.stdout).text();
  await child.exited;
  const result = new Map<number, number>();
  for (const line of text.split('\n')) {
    const [pid, rss] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && rss !== undefined && Number.isFinite(pid) && Number.isFinite(rss)) {
      result.set(pid, rss / 1024);
    }
  }
  return result;
}

async function main(): Promise<number> {
  const cluster = await ProcessCluster.create();
  const steps: StepReport[] = [];
  try {
    const scalar = async (sql: string, params: unknown[] = []): Promise<string> => {
      const rows = (await cluster.database.orm.em.getConnection().execute(sql, params)) as Array<
        Record<string, string>
      >;
      return Object.values(rows[0] ?? {})[0] ?? '';
    };
    const clients = new CreateApiClient({
      repository: new MikroOrmApiClientRepository(cluster.database.orm),
      clock: () => new Date(),
      newId: randomUUID,
    });
    const operatorKey = (await clients.execute({ name: 'operator', role: 'OPERATOR' })).apiKey;
    const providerKey = (
      await clients.execute({ name: 'provider a', role: 'PROVIDER', providerId: 'provider-a' })
    ).apiKey;
    const apis: string[] = [];
    for (let index = 0; index < LOAD_THRESHOLDS.apiProcesses; index += 1) {
      apis.push(await cluster.startApi(`api-${index + 1}`));
    }
    for (let index = 0; index < LOAD_THRESHOLDS.workerProcesses; index += 1) {
      cluster.startWorker(`worker-${index + 1}`);
    }

    const wallets: Array<{ id: string; playerId: string }> = [];
    for (let index = 0; index < LOAD_THRESHOLDS.wallets; index += 1) {
      const playerId = randomUUID();
      const response = await fetch(`${apis[index % apis.length] as string}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: LOAD_THRESHOLDS.startingBalance, currency: 'BRL' },
        }),
      });
      wallets.push({ id: ((await response.json()) as { id: string }).id, playerId });
    }

    const buildOperations = (count: number): Operation[] => {
      const operations: Operation[] = [];
      for (let index = 0; index < count; index += 1) {
        if (operations.length > 0 && Math.random() < LOAD_THRESHOLDS.replayShare) {
          const original = operations[Math.floor(Math.random() * operations.length)] as Operation;
          operations.push({ ...original, replay: true });
          continue;
        }
        const hot = Math.random() < LOAD_THRESHOLDS.hotShare;
        const wallet = hot
          ? (wallets[0] as (typeof wallets)[number])
          : (wallets[Math.floor(Math.random() * wallets.length)] as (typeof wallets)[number]);
        const externalTransactionId = `load-${index}-${randomUUID()}`;
        operations.push({
          key: `provider-a:${externalTransactionId}`,
          body: JSON.stringify({
            providerId: 'provider-a',
            externalTransactionId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'round-987',
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: LOAD_THRESHOLDS.stake, currency: 'BRL' },
          }),
          hot,
          replay: false,
        });
      }
      return operations;
    };

    const runStep = async (rate: number): Promise<StepReport> => {
      const total = Math.round(rate * STEP_SECONDS);
      const interval = 1000 / rate;
      const operations = buildOperations(total);
      const samples: Sample[] = [];
      const peakRssMiB = new Map<string, number>();
      const pidNames = new Map(
        cluster.processes.map((managed: ManagedProcess) => [managed.process.pid, managed.name]),
      );
      const lags: number[] = [];

      const sampleRss = async () => {
        const rss = await rssMiBOf([...pidNames.keys()]);
        for (const [pid, mib] of rss) {
          const name = pidNames.get(pid) ?? String(pid);
          peakRssMiB.set(name, Math.max(peakRssMiB.get(name) ?? 0, mib));
        }
      };
      const sampler = setInterval(() => void sampleRss(), 500);

      const fire = async (index: number, scheduled: number): Promise<void> => {
        const operation = operations[index] as Operation;
        const api = apis[index % apis.length] as string;
        try {
          const response = await fetch(`${api}/wagering/transactions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${providerKey}`,
              'idempotency-key': operation.key,
            },
            body: operation.body,
            signal: AbortSignal.timeout(LOAD_THRESHOLDS.requestTimeoutMs),
          });
          await response.text();
          samples.push({
            latencyMs: performance.now() - scheduled,
            outcome: response.status,
            hot: operation.hot,
          });
        } catch (error) {
          samples.push({
            latencyMs: performance.now() - scheduled,
            outcome: 'LOST',
            hot: operation.hot,
            lostReason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
        }
      };

      const containerSamples = new Map<string, number[]>();
      const containerState = { sampling: true };
      const containerLoop = (async () => {
        while (containerState.sampling) {
          for (const [name, cpu] of await containerCpuSample()) {
            containerSamples.set(name, [...(containerSamples.get(name) ?? []), cpu]);
          }
        }
      })();
      const cpuBefore = await cpuSecondsOf([...pidNames.keys()]);
      const generatorBefore = process.cpuUsage();
      const start = performance.now();
      const inFlight: Promise<void>[] = [];
      let next = 0;
      while (next < total) {
        const due = start + next * interval;
        const now = performance.now();
        if (now < due) {
          await sleep(due - now);
          continue;
        }
        // Send every request that is due. Catching up keeps the schedule, and the lag is recorded.
        while (next < total && start + next * interval <= performance.now()) {
          const scheduled = start + next * interval;
          lags.push(performance.now() - scheduled);
          inFlight.push(fire(next, scheduled));
          next += 1;
        }
      }
      await Promise.all(inFlight);
      const maxLagMs = Math.max(0, ...lags);
      const lagP99Ms = percentile(
        [...lags].sort((left, right) => left - right),
        0.99,
      );
      const elapsedSeconds = (performance.now() - start) / 1000;
      const generatorUsed = process.cpuUsage(generatorBefore);
      const generatorCpuPercent =
        ((generatorUsed.user + generatorUsed.system) / 1e6 / elapsedSeconds) * 100;
      const cpuAfter = await cpuSecondsOf([...pidNames.keys()]);
      const cpuPercent = new Map<string, number>();
      for (const [pid, seconds] of cpuAfter) {
        const before = cpuBefore.get(pid);
        if (before !== undefined) {
          cpuPercent.set(
            pidNames.get(pid) ?? String(pid),
            ((seconds - before) / elapsedSeconds) * 100,
          );
        }
      }
      clearInterval(sampler);
      containerState.sampling = false;
      await containerLoop;
      const containerCpuPercent = new Map(
        [...containerSamples].map(
          ([name, values]) =>
            [name, values.reduce((sum, value) => sum + value, 0) / values.length] as const,
        ),
      );
      await sampleRss();

      const drainStarted = performance.now();
      const drained = await waitUntil(
        async () =>
          (await scalar(
            `SELECT count(*)::text FROM outbox_messages WHERE published_at IS NULL`,
          )) === '0',
        DRAIN_CAP_SECONDS * 1000,
      );
      const drainSeconds = drained
        ? (performance.now() - drainStarted) / 1000
        : Number.POSITIVE_INFINITY;

      const violations = Number(
        await scalar(
          `SELECT count(*)::text FROM wallets w
            WHERE w.balance <> (SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
                                  FROM wallet_ledger_entries l WHERE l.wallet_id = w.id)
               OR w.balance < 0`,
        ),
      );
      const duplicates = Number(
        await scalar(
          `SELECT count(*)::text FROM (SELECT external_transaction_id FROM wager_transactions
             GROUP BY external_transaction_id HAVING count(*) > 1) d`,
        ),
      );

      const answered = samples.filter((sample) => sample.outcome !== 'LOST');
      const latencies = answered
        .map((sample) => sample.latencyMs)
        .sort((left, right) => left - right);
      const distinctLatencies = answered
        .filter((sample) => !sample.hot)
        .map((sample) => sample.latencyMs)
        .sort((left, right) => left - right);
      const hotLatencies = answered
        .filter((sample) => sample.hot)
        .map((sample) => sample.latencyMs)
        .sort((left, right) => left - right);
      const lost = samples.length - answered.length;
      const serverErrors = samples.filter(
        (sample) =>
          sample.outcome === 'LOST' ||
          (typeof sample.outcome === 'number' && sample.outcome >= 500),
      ).length;
      const statusMix = new Map<string, number>();
      for (const sample of samples) {
        const key = String(sample.outcome);
        statusMix.set(key, (statusMix.get(key) ?? 0) + 1);
      }
      const lostReasons = new Map<string, number>();
      for (const sample of samples) {
        if (sample.lostReason !== undefined) {
          lostReasons.set(sample.lostReason, (lostReasons.get(sample.lostReason) ?? 0) + 1);
        }
      }
      const errorRate = samples.length === 0 ? 1 : serverErrors / samples.length;

      const reasons: string[] = [];
      if (lost > LOAD_THRESHOLDS.maxLostRequests)
        reasons.push(`${lost} requests lost (max ${LOAD_THRESHOLDS.maxLostRequests})`);
      if (errorRate > LOAD_THRESHOLDS.maxErrorRate)
        reasons.push(
          `error rate ${(errorRate * 100).toFixed(3)}% (max ${LOAD_THRESHOLDS.maxErrorRate * 100}%)`,
        );
      if (!(percentile(latencies, 0.95) <= LOAD_THRESHOLDS.maxP95Ms))
        reasons.push(
          `p95 ${percentile(latencies, 0.95).toFixed(1)} ms (max ${LOAD_THRESHOLDS.maxP95Ms})`,
        );
      if (!(percentile(latencies, 0.99) <= LOAD_THRESHOLDS.maxP99Ms))
        reasons.push(
          `p99 ${percentile(latencies, 0.99).toFixed(1)} ms (max ${LOAD_THRESHOLDS.maxP99Ms})`,
        );
      if (!(lagP99Ms <= LOAD_THRESHOLDS.maxGeneratorLagP99Ms)) {
        reasons.push(
          `generator lag p99 ${lagP99Ms.toFixed(1)} ms (max ${LOAD_THRESHOLDS.maxGeneratorLagP99Ms})`,
        );
      }
      if (!(drainSeconds <= LOAD_THRESHOLDS.maxOutboxDrainSeconds))
        reasons.push(
          `outbox drained in ${Number.isFinite(drainSeconds) ? drainSeconds.toFixed(1) : 'more than ' + DRAIN_CAP_SECONDS} s (max ${LOAD_THRESHOLDS.maxOutboxDrainSeconds})`,
        );
      if (violations > 0)
        reasons.push(`${violations} wallets where balance differs from the ledger`);
      if (duplicates > 0) reasons.push(`${duplicates} transactions processed more than once`);
      for (const [name, mib] of peakRssMiB) {
        if (mib > LOAD_THRESHOLDS.maxRssMiBPerProcess)
          reasons.push(
            `${name} peaked at ${mib.toFixed(0)} MiB (max ${LOAD_THRESHOLDS.maxRssMiBPerProcess})`,
          );
      }

      const report: StepReport = {
        rate,
        seconds: STEP_SECONDS,
        sent: samples.length,
        answered: answered.length,
        lost,
        serverErrors,
        errorRate,
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        max: latencies.at(-1) ?? Number.NaN,
        hotP99: percentile(hotLatencies, 0.99),
        distinctP99: percentile(distinctLatencies, 0.99),
        cpuPercent,
        generatorCpuPercent,
        containerCpuPercent,
        lostReasons,
        maxLagMs,
        lagP99Ms,
        drainSeconds,
        violations,
        duplicates,
        peakRssMiB,
        statusMix,
        reasons,
      };
      console.log(
        `rate ${rate}/s: sent ${report.sent}, lost ${lost}, errors ${serverErrors}, p99 ${report.p99.toFixed(1)} ms, drain ${Number.isFinite(drainSeconds) ? drainSeconds.toFixed(1) : 'none'} s, ${reasons.length === 0 ? 'PASS' : 'FAIL: ' + reasons.join('; ')}`,
      );
      return report;
    };

    for (const rate of RATES) {
      const report = await runStep(rate);
      steps.push(report);
      if (report.reasons.length > 0) break;
    }

    // Stop the workers gracefully, so that they print their final metrics.
    const workers = cluster.processes.filter((managed) => managed.name.startsWith('worker-'));
    for (const worker of workers) {
      worker.process.kill('SIGTERM');
      await worker.process.exited;
    }
    const apiCounters = await Promise.all(
      apis.map(async (api) => {
        const response = await fetch(`${api}/metrics`, {
          headers: { authorization: `Bearer ${operatorKey}` },
        });
        return ((await response.json()) as { counters: Record<string, number> }).counters;
      }),
    );
    const concurrencyConflicts = apiCounters.reduce(
      (sum, counters) => sum + (counters['concurrency_conflicts_total'] ?? 0),
      0,
    );
    const passing = steps.filter((step) => step.reasons.length === 0);
    const agreed = passing.at(-1);
    const failing = steps.find((step) => step.reasons.length > 0);
    const totalSent = steps.reduce((sum, step) => sum + step.sent, 0);
    const report = renderReport({
      steps,
      agreed,
      failing,
      totalSent,
      concurrencyConflicts,
    });
    await writeFile(REPORT_PATH, report);
    console.log(`\nagreed sustained rate: ${agreed ? `${agreed.rate} requests/s` : 'none'}`);
    console.log(`report written to docs/LOAD_TEST_RESULTS.md`);
    return agreed === undefined ? 1 : 0;
  } finally {
    await cluster.close();
  }
}

/** The CPU model from /proc/cpuinfo, on Linux. Elsewhere the report says unknown. */
function cpuModelName(): string {
  try {
    const line = readFileSync('/proc/cpuinfo', 'utf8')
      .split('\n')
      .find((candidate) => candidate.startsWith('model name'));
    return line?.split(':')[1]?.trim() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** One row of the CPU table: each process, then the two containers, then the generator. */
function componentRow(step: StepReport): string {
  const processCpu = (name: string) => step.cpuPercent.get(name);
  const containerCpu = (fragment: string) =>
    [...step.containerCpuPercent].find(([name]) => name.includes(fragment))?.[1];
  const values = [
    processCpu('api-1'),
    processCpu('api-2'),
    processCpu('api-3'),
    processCpu('worker-1'),
    processCpu('worker-2'),
    containerCpu('postgres'),
    containerCpu('localstack'),
    step.generatorCpuPercent,
  ];
  return `| ${step.rate} | ${values.map((value) => (value === undefined ? 'n/a' : cell(value, 0))).join(' | ')} |`;
}

function cell(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function renderReport(input: {
  steps: StepReport[];
  agreed: StepReport | undefined;
  failing: StepReport | undefined;
  totalSent: number;
  concurrencyConflicts: number;
}): string {
  const { steps, agreed, failing, totalSent, concurrencyConflicts } = input;
  const cpuName = cpuModelName();
  const peakRss = new Map<string, number>();
  const statusMix = new Map<string, number>();
  for (const step of steps) {
    for (const [name, mib] of step.peakRssMiB)
      peakRss.set(name, Math.max(peakRss.get(name) ?? 0, mib));
    for (const [status, count] of step.statusMix)
      statusMix.set(status, (statusMix.get(status) ?? 0) + count);
  }
  const rows = steps
    .map((step) => {
      const stackCpu = [...step.cpuPercent.values()].reduce((sum, value) => sum + value, 0);
      const largest = Math.max(0, ...step.peakRssMiB.values());
      return `| ${step.rate} | ${step.sent} | ${step.lost} | ${step.serverErrors} | ${(step.errorRate * 100).toFixed(3)}% | ${cell(step.p50)} | ${cell(step.p95)} | ${cell(step.p99)} | ${cell(step.distinctP99)} | ${cell(step.hotP99)} | ${cell(step.max)} | ${cell(step.lagP99Ms)} | ${Number.isFinite(step.drainSeconds) ? cell(step.drainSeconds) : 'not drained'} | ${cell(largest, 0)} | ${cell(stackCpu, 0)} | ${cell(step.generatorCpuPercent, 0)} | ${step.reasons.length === 0 ? 'PASS' : 'FAIL'} |`;
    })
    .join('\n');
  const lostRows =
    steps
      .flatMap((step) =>
        [...step.lostReasons].map(([reason, count]) => `| ${step.rate} | ${reason} | ${count} |`),
      )
      .join('\n') || '| none | | 0 |';
  const memory = [...peakRss]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, mib]) => `| ${name} | ${cell(mib, 0)} |`)
    .join('\n');
  const mix = [...statusMix]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([status, count]) => `| ${status} | ${count} |`)
    .join('\n');
  const verdict = agreed
    ? `**Agreed sustained rate on this machine: ${agreed.rate} requests per second.** It is the highest step that passed every constraint, held for ${agreed.seconds} seconds.`
    : '**No step passed every constraint.** The lowest rate already breaks at least one constraint. See the first failing step below.';
  const failure = failing
    ? `**First failing step: ${failing.rate} requests per second.** It broke: ${failing.reasons.join('; ')}.`
    : 'No step failed. The ramp reached its last rate.';
  const limits = [
    'It proves that the system kept its constraints for the length of one step, at one rate, on this machine.',
    'It does not prove a rate for longer than a step. There is no soak test.',
    'The API, the workers, PostgreSQL, LocalStack and the load generator run on the same CPUs. The table of CPU use shows how much of the machine each one took. On a dedicated machine, or on a larger one, the knee would move.',
    'The queue is LocalStack, not AWS SQS. Its latency and its limits differ from AWS.',
    'PostgreSQL runs with its default configuration, on local disk, with no replica and no tuning.',
    'The mix is ours: BET operations over 50 wallets, with about 5% on one hot wallet and about 5% replays. Real provider traffic has WIN, LOSS, REFUND and ROLLBACK as well.',
    'Latency is the client view, measured from the scheduled send time. The percentiles come from our own sample, not from a histogram.',
    'Business rejections (422, 409) are answers, not errors. Errors are 5xx and requests that got no response.',
    'Each step ran once. There is no confidence interval.',
    'Outbox lag during a step is not measured per event. The drain time after the step is measured, and the server summary gives only the average and the maximum.',
    'Memory and CPU come from `ps`, so the run needs Linux or macOS. On Windows, run it inside WSL. CPU is in whole seconds, sampled at the start and end of each step.',
  ]
    .map((line) => `- ${line}`)
    .join('\n');
  return `# Load test results

Generated by \`bun run test:load\` on ${new Date().toISOString()}. The constraints are in
\`test/load/thresholds.ts\`. The method is in \`DECISIONS.md\`, group N.

## Verdict

${verdict}

${failure}

Total requests sent in this run: ${totalSent}. Lost requests in the run: ${steps.reduce((sum, step) => sum + step.lost, 0)}.
Lock races lost and retried across all API processes: ${concurrencyConflicts}.

## Constraints

| Constraint | Value |
| --- | --- |
| Error rate (5xx and lost, over requests sent) | at most ${LOAD_THRESHOLDS.maxErrorRate * 100}% |
| Lost requests (no HTTP response within ${LOAD_THRESHOLDS.requestTimeoutMs / 1000} s) | at most ${LOAD_THRESHOLDS.maxLostRequests} |
| p95 latency, answered requests | at most ${LOAD_THRESHOLDS.maxP95Ms} ms |
| p99 latency, answered requests | at most ${LOAD_THRESHOLDS.maxP99Ms} ms |
| Generator lag behind the schedule, p99 | at most ${LOAD_THRESHOLDS.maxGeneratorLagP99Ms} ms |
| Outbox drained after the step | within ${LOAD_THRESHOLDS.maxOutboxDrainSeconds} s |
| Resident memory of any one process | at most ${LOAD_THRESHOLDS.maxRssMiBPerProcess} MiB |
| Balance equals the ledger, and no balance below zero | every wallet, every step |
| A transaction processed twice | none |

## Steps

Each step sends requests on a fixed schedule for ${STEP_SECONDS} seconds. Latency is measured from
the scheduled time, in milliseconds. CPU is a percent of one logical CPU, summed over the stack, and
the generator is shown on its own.

| Rate (req/s) | Sent | Lost | 5xx or lost | Error rate | p50 | p95 | p99 | Distinct-wallet p99 | Hot-wallet p99 | max | Generator lag p99 (ms) | Outbox drain (s) | Largest process RSS (MiB) | Stack CPU (%) | Generator CPU (%) | Verdict |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows}

With ${cpus().length} logical CPUs, a stack CPU of ${cpus().length * 100}% would be the whole machine.

### CPU by component

Each API process and each worker is one Bun process, which runs on one thread. Its CPU cannot pass
100% of one CPU. PostgreSQL and LocalStack are containers, and their percentages come from
\`docker stats\`. The generator is the load driver itself.

| Rate (req/s) | api-1 | api-2 | api-3 | worker-1 | worker-2 | PostgreSQL | LocalStack | Generator |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${steps.map((step) => componentRow(step)).join('\n')}

## Lost requests

Each lost request, with the error the client saw. Only the steps that lost a request are listed.

| Rate (req/s) | Error | Count |
| ---: | --- | ---: |
${lostRows}

## Memory

Peak resident memory of each process, over the whole run.

| Process | Peak RSS (MiB) |
| --- | ---: |
${memory}

## Status mix

Counted over every step of the run.

| Status | Count |
| --- | ---: |
${mix}

## Environment

| Item | Value |
| --- | --- |
| Platform | ${platform()} ${release()} (${arch()}) |
| CPU | ${cpuName} |
| Logical CPUs | ${cpus().length} |
| Memory | ${(totalmem() / 1024 ** 3).toFixed(1)} GiB |
| Bun | ${Bun.version} |
| Processes | ${LOAD_THRESHOLDS.apiProcesses} API, ${LOAD_THRESHOLDS.workerProcesses} workers, one PostgreSQL 17, one LocalStack 4.14 |

## Definitions

- **Sent**: a request the generator put on the wire at its scheduled time.
- **Answered**: a request that received an HTTP response of any status.
- **Lost**: a request that received no response: a timeout, or a connection that closed.
- **Error**: a 5xx answer, or a lost request. A 4xx answer (422, 409, 400) is a correct answer, and it is not an error.
- **Generator lag**: how late the generator sent a request compared with its schedule.

## What these numbers prove, and what they do not

${limits}

## How to reproduce on another machine

\`\`\`bash
bun run infra:up
bun run test:load
\`\`\`

Both commands write this file again. For a quick check, use \`LOAD_RATES=25,50 LOAD_STEP_SECONDS=3 bun run test:load\`.
Do not compare a number from another machine with this one without the environment table next to it.
`;
}

process.exitCode = await main();
