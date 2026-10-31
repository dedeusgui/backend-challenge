/**
 * Load test (ARCHITECTURE.md section 14). It runs the real stack as independent processes, three API
 * processes and two workers, on one PostgreSQL and one LocalStack, under a product mix (test/load/workload.ts).
 *
 * The stack is pinned to a number of CPUs (LOAD_CPUS, default: every CPU of the host). The processes
 * are pinned with taskset and the containers with their cpuset, and the generator runs on the CPUs the
 * stack does not use. So the figures are for a machine with that many CPUs, and the CPU per request does
 * not count the generator.
 *
 * Requests are sent on a schedule at a fixed rate per step: an open model. The next request is sent when
 * its time comes, whether or not the previous one has answered. Latency is measured from the scheduled
 * time, so a slow system cannot hide its queue by slowing the sender (coordinated omission).
 *
 * Each step is checked against LOAD_THRESHOLDS. The ramp stops at the first failing step, and the agreed
 * rate is the highest step that passed. Each CPU count writes docs/load/results/cpus-<N>.json, and the
 * report (docs/LOAD_TEST_RESULTS.md) is rendered from all of them.
 *
 * Run with `bun run test:load`. It is not part of `check:all`. Its numbers describe the machine that runs
 * it. For a quick check, set LOAD_RATES=25,50 and LOAD_STEP_SECONDS=3, and point LOAD_RESULTS_DIR and
 * LOAD_REPORT_PATH at a scratch directory, so that the committed results are not overwritten.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { CreateApiClient } from '../../src/modules/auth/application/create-api-client.use-case';
import { MikroOrmApiClientRepository } from '../../src/modules/auth/infrastructure/mikro-orm-api-client.repository';
import { ProcessCluster, type ManagedProcess } from '../concurrency/support/process-cluster';
import {
  affinityOf,
  allowedCpus,
  containersOf,
  cpusetOf,
  planPinning,
  setCpuset,
  type PinningPlan,
} from './host';
import {
  countersOfBody,
  formatCpuList,
  LINUX_CLOCK_TICKS,
  mergeSummaries,
  parseCpuList,
  parseCpuListOrNone,
  parseDockerStats,
  parsePidTable,
  parseProcStatRssKiB,
  parseProcStatTicks,
  percentile,
  stripTerminalCodes,
  summariesFromOutput,
  summariesOfBody,
} from './metrics';
import {
  RUN_FORMAT,
  RUN_VERSION,
  type KindRecord,
  type RunRecord,
  type StepRecord,
} from './records';
import { readRuns, renderReport, writeRun } from './report';
import {
  acceptableAnswers,
  appliedBy,
  classifyAnswer,
  DRAIN_CAP_SECONDS,
  dependencyOf,
  incorrectAnswers,
  stepReasons,
} from './judgement';
import { LOAD_THRESHOLDS } from './thresholds';
import {
  WORKLOAD_KINDS,
  createPlanner,
  requestFor,
  type PlannedOperation,
  type RequestContext,
  type WorkloadKind,
  type WorkloadWallet,
} from './workload';

const env = process.env;
const RATES: readonly number[] = env.LOAD_RATES
  ? env.LOAD_RATES.split(',').map(Number)
  : LOAD_THRESHOLDS.stepRatesPerSecond;
const STEP_SECONDS = Number(env.LOAD_STEP_SECONDS ?? LOAD_THRESHOLDS.stepSeconds);
const IDLE_SECONDS = Number(env.LOAD_IDLE_SECONDS ?? LOAD_THRESHOLDS.idleSeconds);
const WARMUP_SECONDS = Number(env.LOAD_WARMUP_SECONDS ?? LOAD_THRESHOLDS.warmupSeconds);
const RESULTS_DIR = env.LOAD_RESULTS_DIR ?? `${import.meta.dir}/../../docs/load/results`;
const REPORT_PATH = env.LOAD_REPORT_PATH ?? `${import.meta.dir}/../../docs/LOAD_TEST_RESULTS.md`;
const PROVIDER_ID = 'provider-a';
const GAME_ID = 'fortune-chimp';
const CONTAINER_SERVICES = ['postgres', 'localstack'] as const;
/** The generator re-launches itself with this set, so that it does not plan its pinning twice. */
const PLAN_MARK = 'LOAD_PINNING_PLAN';
const LOCK_SAMPLE_MS = 200;
const RSS_SAMPLE_MS = 500;

interface Sample {
  kind: WorkloadKind;
  latencyMs: number;
  outcome: number | 'LOST';
  /** The answer the request gets when it does its job. */
  primary: number;
  /** Every answer the contract allows this request, given what the client knew when it sent it. */
  acceptable: readonly number[];
  hot: boolean;
  /** For a lost request: the error class and its message. Never a payload. */
  lostReason?: string;
}

interface CpuWindow {
  elapsedSeconds: number;
  cpuPercent: Record<string, number>;
  generatorCpuPercent: number;
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

/** The output of a command. Its exit status is not an error here: `ps` fails when a process has just gone. */
async function capture(command: string[]): Promise<string> {
  try {
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore' });
    const text = await new Response(child.stdout).text();
    await child.exited;
    return text;
  } catch {
    return '';
  }
}

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) throw new Error('no items to pick from');
  return item;
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return finite(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** The record name of a container, from its docker name. Other containers are not part of the stack. */
function componentOf(name: string): (typeof CONTAINER_SERVICES)[number] | undefined {
  return CONTAINER_SERVICES.find((service) => name.includes(service));
}

/** Cumulative CPU seconds of each process. /proc gives it exactly on Linux; elsewhere ps gives whole seconds. */
async function cpuSecondsOf(pids: number[]): Promise<Map<number, number>> {
  const fromProc = new Map<number, number>();
  for (const pid of pids) {
    try {
      const stat = await Bun.file(`/proc/${pid}/stat`).text();
      fromProc.set(pid, parseProcStatTicks(stat) / LINUX_CLOCK_TICKS);
    } catch {
      // The process has gone, or /proc is not there.
    }
  }
  if (fromProc.size > 0) return fromProc;
  return parsePidTable(await capture(['ps', '-o', 'pid=,cputimes=', '-p', pids.join(',')]));
}

/** Resident memory in MiB of each process: from /proc on Linux, from ps elsewhere. */
async function rssMiBOf(pids: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  for (const pid of pids) {
    try {
      const kib = parseProcStatRssKiB(await Bun.file(`/proc/${pid}/status`).text());
      if (kib !== undefined) result.set(pid, kib / 1024);
    } catch {
      // The process has gone, or /proc is not there.
    }
  }
  if (result.size > 0) return result;
  const table = parsePidTable(await capture(['ps', '-o', 'pid=,rss=', '-p', pids.join(',')]));
  return new Map([...table].map(([pid, kib]) => [pid, kib / 1024] as const));
}

/** Runs a sample on a loop until it is stopped, with a pause between samples. */
function sampler(intervalMs: number, tick: () => Promise<void>): { stop: () => Promise<void> } {
  const state = { running: true };
  const loop = (async () => {
    while (state.running) {
      await tick();
      if (state.running) await sleep(intervalMs);
    }
  })();
  return {
    stop: async () => {
      state.running = false;
      await loop;
    },
  };
}

/**
 * CPU of the containers, from one long-lived `docker stats` stream. The generator reads it
 * asynchronously and never starts a process while it sends requests. Each reading is timestamped, and
 * a window averages the readings taken inside it. The stream is sampled, not counted: docker reports a
 * percentage per reading.
 */
function startContainerStream(): {
  finish: (start: number, end: number) => Record<string, number>;
  stop: () => void;
} {
  const readings: Array<{ at: number; component: string; cpu: number }> = [];
  let stdout: ReadableStream<Uint8Array> | undefined;
  let kill: () => void = () => undefined;
  try {
    const child = Bun.spawn(['docker', 'stats', '--format', '{{.Name}}\t{{.CPUPerc}}'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    stdout = child.stdout;
    kill = () => child.kill();
  } catch {
    // Without docker there are no container figures; the report shows them as n/a.
  }
  const readStream = async (): Promise<void> => {
    if (stdout === undefined) return;
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const at = performance.now();
        for (const [name, cpu] of parseDockerStats(stripTerminalCodes(line))) {
          const component = componentOf(name);
          if (component !== undefined) readings.push({ at, component, cpu });
        }
      }
    }
  };
  // The stream is read in the background and never awaited: the generator must not wait on docker.
  readStream().catch(() => undefined);
  return {
    finish: (start, end) => {
      const sums = new Map<string, number[]>();
      for (const entry of readings) {
        if (entry.at < start || entry.at > end) continue;
        sums.set(entry.component, [...(sums.get(entry.component) ?? []), entry.cpu]);
      }
      return Object.fromEntries(
        [...sums].map(([component, values]) => [
          component,
          values.reduce((sum, value) => sum + value, 0) / values.length,
        ]),
      );
    },
    stop: () => kill(),
  };
}

/** Measures the CPU of the stack and of the generator over one piece of work. */
async function measureWindow(
  names: ReadonlyMap<number, string>,
  containers: ReturnType<typeof startContainerStream>,
  work: () => Promise<void>,
): Promise<CpuWindow> {
  const pids = [...names.keys()];
  const cpuBefore = await cpuSecondsOf(pids);
  const generatorBefore = process.cpuUsage();
  const start = performance.now();
  await work();
  const generatorUsed = process.cpuUsage(generatorBefore);
  const end = performance.now();
  const cpuAfter = await cpuSecondsOf(pids);
  const elapsedSeconds = (end - start) / 1000;

  const cpuPercent: Record<string, number> = {};
  for (const [pid, seconds] of cpuAfter) {
    const before = cpuBefore.get(pid);
    const name = names.get(pid);
    if (before !== undefined && name !== undefined) {
      cpuPercent[name] = ((seconds - before) / elapsedSeconds) * 100;
    }
  }
  Object.assign(cpuPercent, containers.finish(start, end));
  return {
    elapsedSeconds,
    cpuPercent,
    generatorCpuPercent: ((generatorUsed.user + generatorUsed.system) / 1e6 / elapsedSeconds) * 100,
  };
}

function hotOf(operation: PlannedOperation): boolean {
  return operation.kind === 'READ_WALLET' ? operation.wallet === 0 : operation.bet.hot;
}

function sortedLatencies(samples: readonly Sample[]): number[] {
  return samples.map((sample) => sample.latencyMs).sort((left, right) => left - right);
}

function kindRecords(samples: readonly Sample[]): Record<string, KindRecord> {
  const result: Record<string, KindRecord> = {};
  for (const kind of WORKLOAD_KINDS) {
    const own = samples.filter((sample) => sample.kind === kind);
    if (own.length === 0) continue;
    const answered = own.filter((sample) => sample.outcome !== 'LOST');
    const latencies = sortedLatencies(answered);
    const statuses: Record<string, number> = {};
    for (const sample of own) {
      const key = String(sample.outcome);
      statuses[key] = (statuses[key] ?? 0) + 1;
    }
    result[kind] = {
      sent: own.length,
      answered: answered.length,
      unexpected: answered.filter((sample) => classifyAnswer(sample) === 'incorrect').length,
      concurrent: answered.filter((sample) => classifyAnswer(sample) === 'concurrent').length,
      p50: finite(percentile(latencies, 0.5)),
      p95: finite(percentile(latencies, 0.95)),
      p99: finite(percentile(latencies, 0.99)),
      statuses,
    };
  }
  return result;
}

function cpuModelName(): string {
  return cpus()[0]?.model ?? 'unknown';
}

/** Starts the stack, pinned as the plan says, and returns what the run needs. */
async function runLoad(plan: PinningPlan): Promise<number> {
  const stackList = formatCpuList(plan.stack);
  const generatorList = plan.generator.length > 0 ? formatCpuList(plan.generator) : null;
  const cluster = await ProcessCluster.create({ cpus: plan.pinned ? stackList : undefined });
  const containerCpusets: Record<string, string> = {};
  const restores: Array<() => Promise<void>> = [];
  const containers = startContainerStream();
  try {
    if (plan.pinned) {
      for (const service of CONTAINER_SERVICES) {
        for (const container of await containersOf(service)) {
          const original = await cpusetOf(container);
          restores.push(() =>
            setCpuset(container, original === '' ? formatCpuList(plan.allowed) : original),
          );
          await setCpuset(container, stackList);
          containerCpusets[service] = stackList;
        }
      }
    }
    return await measureRun(cluster, plan, containers, stackList, generatorList, containerCpusets);
  } finally {
    containers.stop();
    for (const restore of restores.reverse()) {
      try {
        await restore();
      } catch (error) {
        console.error(`could not restore a container cpuset: ${String(error)}`);
      }
    }
    await cluster.close();
  }
}

async function measureRun(
  cluster: ProcessCluster,
  plan: PinningPlan,
  containers: ReturnType<typeof startContainerStream>,
  stackList: string,
  generatorList: string | null,
  containerCpusets: Record<string, string>,
): Promise<number> {
  const clients = new CreateApiClient({
    repository: new MikroOrmApiClientRepository(cluster.database.orm),
    clock: () => new Date(),
    newId: randomUUID,
  });
  const operatorKey = (await clients.execute({ name: 'operator', role: 'OPERATOR' })).apiKey;
  const providerKey = (
    await clients.execute({ name: 'provider a', role: 'PROVIDER', providerId: PROVIDER_ID })
  ).apiKey;

  const apis: string[] = [];
  for (let index = 0; index < LOAD_THRESHOLDS.apiProcesses; index += 1) {
    apis.push(await cluster.startApi(`api-${index + 1}`));
  }
  for (let index = 0; index < LOAD_THRESHOLDS.workerProcesses; index += 1) {
    cluster.startWorker(`worker-${index + 1}`);
  }
  const names = new Map<number, string>(
    cluster.processes.map((managed: ManagedProcess) => [managed.process.pid, managed.name]),
  );

  const observedAffinity: Record<string, string> = {};
  if (plan.pinned) {
    for (const managed of cluster.processes) {
      const list = await affinityOf(managed.process.pid);
      if (list !== undefined) observedAffinity[managed.name] = formatCpuList(parseCpuList(list));
    }
  }

  const wallets: WorkloadWallet[] = [];
  for (let index = 0; index < LOAD_THRESHOLDS.wallets; index += 1) {
    const playerId = randomUUID();
    const response = await fetch(`${pick(apis, index)}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: LOAD_THRESHOLDS.startingBalance, currency: 'BRL' },
      }),
    });
    wallets.push({ id: ((await response.json()) as { id: string }).id, playerId });
  }

  const context: RequestContext = {
    providerId: PROVIDER_ID,
    gameId: GAME_ID,
    wallets,
    stake: LOAD_THRESHOLDS.stake,
    winAmount: LOAD_THRESHOLDS.winAmount,
  };
  const planner = createPlanner({
    mix: LOAD_THRESHOLDS.workloadPercent,
    wallets: wallets.length,
    hotShare: LOAD_THRESHOLDS.hotShare,
    settleAfter: LOAD_THRESHOLDS.settleAfterOperations,
    readAfter: LOAD_THRESHOLDS.readAfterOperations,
    replayAfter: LOAD_THRESHOLDS.replayAfterOperations,
    runId: randomUUID().slice(0, 8),
    random: Math.random,
  });

  const outboxCount = async (): Promise<number> =>
    Number(
      (
        (await cluster.database.orm.em
          .getConnection()
          .execute('SELECT count(*)::text AS n FROM outbox_messages')) as Array<{ n: string }>
      )[0]?.n ?? 'NaN',
    );
  const unpublished = async (): Promise<number> =>
    Number(
      (
        (await cluster.database.orm.em
          .getConnection()
          .execute(
            'SELECT count(*)::text AS n FROM outbox_messages WHERE published_at IS NULL',
          )) as Array<{ n: string }>
      )[0]?.n ?? 'NaN',
    );
  const scalar = async (sql: string): Promise<string> => {
    const rows = (await cluster.database.orm.em.getConnection().execute(sql)) as Array<
      Record<string, string>
    >;
    return Object.values(rows[0] ?? {})[0] ?? '';
  };

  // The BETs applied so far in this run, across the warm-up and every step.
  const applied = new Set<string>();
  // The warm-up is run and not kept: its requests warm the stack, and the drain after it keeps the idle
  // measurement free of publishing.
  const warmup = await runStep({
    rate: LOAD_THRESHOLDS.warmupRatePerSecond,
    seconds: WARMUP_SECONDS,
    cluster,
    names,
    apis,
    operatorKey,
    providerKey,
    context,
    planner,
    containers,
    outboxCount,
    unpublished,
    scalar,
    applied,
  });
  const idle = await measureWindow(names, containers, () => sleep(IDLE_SECONDS * 1000));

  const steps: StepRecord[] = [];
  for (const rate of RATES) {
    const step = await runStep({
      rate,
      seconds: STEP_SECONDS,
      cluster,
      names,
      apis,
      operatorKey,
      providerKey,
      context,
      planner,
      containers,
      outboxCount,
      unpublished,
      scalar,
      applied,
    });
    steps.push(step);
    console.log(
      `rate ${rate}/s: sent ${step.sent}, lost ${step.lost}, errors ${step.serverErrors}, p99 ${step.p99?.toFixed(1) ?? 'n/a'} ms, ${step.reasons.length === 0 ? 'PASS' : `FAIL: ${step.reasons.join('; ')}`}`,
    );
    if (step.reasons.length > 0) break;
  }

  // Stop the workers gracefully, so that they print their final metrics.
  for (const managed of cluster.processes.filter((candidate) =>
    candidate.name.startsWith('worker-'),
  )) {
    managed.process.kill('SIGTERM');
    await managed.process.exited;
  }
  const apiBodies: unknown[] = await Promise.all(
    apis.map(async (api) => {
      const response = await fetch(`${api}/metrics`, {
        headers: { authorization: `Bearer ${operatorKey}` },
      });
      return response.json();
    }),
  );
  const apiCounters = apiBodies.map((body) => countersOfBody(body));
  const phases = mergeSummaries([
    ...apiBodies.map((body) => summariesOfBody(body) ?? {}),
    ...cluster.processes
      .filter((candidate) => candidate.name.startsWith('worker-'))
      .map((candidate) => summariesFromOutput(candidate.recentOutput()) ?? {}),
  ]);

  const passing = steps.filter((step) => step.reasons.length === 0);
  const run: RunRecord = {
    format: RUN_FORMAT,
    version: RUN_VERSION,
    generatedAt: new Date().toISOString(),
    stackCpus: plan.stack.length,
    stackCpuList: plan.pinned ? stackList : 'all',
    generatorCpuList: generatorList,
    pinned: plan.pinned,
    hostLogicalCpus: plan.allowed.length,
    observedAffinity,
    containerCpusets,
    environment: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpuModel: cpuModelName(),
      memoryGiB: totalmem() / 1024 ** 3,
      bun: Bun.version,
      topology: `${LOAD_THRESHOLDS.apiProcesses} API, ${LOAD_THRESHOLDS.workerProcesses} workers, one PostgreSQL 17, one LocalStack 4.14`,
    },
    constraints: {
      stepSeconds: STEP_SECONDS,
      requestTimeoutMs: LOAD_THRESHOLDS.requestTimeoutMs,
      maxErrorRate: LOAD_THRESHOLDS.maxErrorRate,
      maxLostRequests: LOAD_THRESHOLDS.maxLostRequests,
      maxP95Ms: LOAD_THRESHOLDS.maxP95Ms,
      maxP99Ms: LOAD_THRESHOLDS.maxP99Ms,
      maxGeneratorLagP99Ms: LOAD_THRESHOLDS.maxGeneratorLagP99Ms,
      maxOutboxDrainSeconds: LOAD_THRESHOLDS.maxOutboxDrainSeconds,
      maxRssMiBPerProcess: LOAD_THRESHOLDS.maxRssMiBPerProcess,
    },
    workload: {
      mixPercent: { ...LOAD_THRESHOLDS.workloadPercent },
      planned: { ...planner.counts },
      wallets: LOAD_THRESHOLDS.wallets,
      hotShare: LOAD_THRESHOLDS.hotShare,
      stake: LOAD_THRESHOLDS.stake,
      winAmount: LOAD_THRESHOLDS.winAmount,
      settleAfterOperations: LOAD_THRESHOLDS.settleAfterOperations,
      readAfterOperations: LOAD_THRESHOLDS.readAfterOperations,
      replayAfterOperations: LOAD_THRESHOLDS.replayAfterOperations,
    },
    warmup: {
      ratePerSecond: LOAD_THRESHOLDS.warmupRatePerSecond,
      seconds: WARMUP_SECONDS,
      sent: warmup.sent,
    },
    idle: { seconds: IDLE_SECONDS, cpuPercent: idle.cpuPercent },
    steps,
    agreedRate: passing.at(-1)?.rate ?? null,
    firstFailingRate: steps.find((step) => step.reasons.length > 0)?.rate ?? null,
    concurrencyConflicts: apiCounters.reduce(
      (sum, counters) => sum + (counters['concurrency_conflicts_total'] ?? 0),
      0,
    ),
    totalSent: steps.reduce((sum, step) => sum + step.sent, 0),
    phases,
  };

  const written = await writeRun(RESULTS_DIR, run);
  const runs = await readRuns(RESULTS_DIR);
  await writeFile(REPORT_PATH, renderReport(runs, new Date().toISOString()));
  console.log(
    `\nagreed sustained rate on ${run.stackCpus} CPU${run.stackCpus === 1 ? '' : 's'}: ${run.agreedRate === null ? 'none' : `${run.agreedRate} requests/s`}`,
  );
  console.log(`run written to ${written}`);
  console.log(`report written to ${REPORT_PATH}`);
  return run.agreedRate === null ? 1 : 0;
}

interface StepInput {
  rate: number;
  seconds: number;
  cluster: ProcessCluster;
  names: ReadonlyMap<number, string>;
  apis: string[];
  operatorKey: string;
  providerKey: string;
  context: RequestContext;
  planner: ReturnType<typeof createPlanner>;
  containers: ReturnType<typeof startContainerStream>;
  outboxCount: () => Promise<number>;
  unpublished: () => Promise<number>;
  scalar: (sql: string) => Promise<string>;
  /** The BETs the run has seen applied, across every step: a later request is judged against them. */
  applied: Set<string>;
}

async function runStep(input: StepInput): Promise<StepRecord> {
  const {
    rate,
    seconds,
    cluster,
    names,
    apis,
    operatorKey,
    providerKey,
    context,
    planner,
    applied,
  } = input;
  const total = Math.round(rate * seconds);
  const interval = 1000 / rate;
  const operations = planner.next(total);
  const samples: Sample[] = [];
  const lags: number[] = [];
  const pids = [...names.keys()];
  const peakRssMiB = new Map<string, number>();
  const lockWaiters: number[] = [];
  const idleInTransaction: number[] = [];
  let sessionsMax = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const sampleRss = async (): Promise<void> => {
    for (const [pid, mib] of await rssMiBOf(pids)) {
      const name = names.get(pid);
      if (name !== undefined) peakRssMiB.set(name, Math.max(peakRssMiB.get(name) ?? 0, mib));
    }
  };
  const rss = sampler(RSS_SAMPLE_MS, sampleRss);
  const locks = sampler(LOCK_SAMPLE_MS, async () => {
    const rows = (await cluster.database.orm.em.getConnection().execute(
      `SELECT count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS locked,
              count(*) FILTER (WHERE state = 'idle in transaction')::text AS idle_in_transaction,
              count(*)::text AS sessions
         FROM pg_stat_activity
        WHERE datname = current_database() AND backend_type = 'client backend'
          AND pid <> pg_backend_pid()`,
    )) as Array<{ locked: string; idle_in_transaction: string; sessions: string }>;
    lockWaiters.push(Number(rows[0]?.locked ?? 0));
    idleInTransaction.push(Number(rows[0]?.idle_in_transaction ?? 0));
    sessionsMax = Math.max(sessionsMax, Number(rows[0]?.sessions ?? 0));
  });
  const eventsBefore = await input.outboxCount();

  const fire = async (
    operation: PlannedOperation,
    index: number,
    scheduled: number,
  ): Promise<void> => {
    const request = requestFor(operation, context);
    const dependency = dependencyOf(operation);
    const acceptable = acceptableAnswers({
      kind: operation.kind,
      dependencyApplied: dependency === undefined ? undefined : applied.has(dependency),
    });
    const headers: Record<string, string> = {
      authorization: `Bearer ${request.audience === 'operator' ? operatorKey : providerKey}`,
    };
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    if (request.idempotencyKey !== undefined) headers['idempotency-key'] = request.idempotencyKey;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const response = await fetch(`${pick(apis, index)}${request.path}`, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(LOAD_THRESHOLDS.requestTimeoutMs),
      });
      await response.text();
      const applies = appliedBy(operation, response.status);
      if (applies !== undefined) applied.add(applies);
      samples.push({
        kind: operation.kind,
        latencyMs: performance.now() - scheduled,
        outcome: response.status,
        primary: request.expectedStatus,
        acceptable,
        hot: hotOf(operation),
      });
    } catch (error) {
      samples.push({
        kind: operation.kind,
        latencyMs: performance.now() - scheduled,
        outcome: 'LOST',
        primary: request.expectedStatus,
        acceptable,
        hot: hotOf(operation),
        lostReason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    } finally {
      inFlight -= 1;
    }
  };

  const cpu = await measureWindow(names, input.containers, async () => {
    const start = performance.now();
    const pending: Promise<void>[] = [];
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
        const operation = operations[next];
        if (operation !== undefined) pending.push(fire(operation, next, scheduled));
        next += 1;
      }
    }
    await Promise.all(pending);
  });
  await locks.stop();
  await rss.stop();
  await sampleRss();

  const eventsCreated = (await input.outboxCount()) - eventsBefore;
  const drainStarted = performance.now();
  const drained = await waitUntil(
    async () => (await input.unpublished()) === 0,
    DRAIN_CAP_SECONDS * 1000,
  );
  const drainSeconds = drained ? (performance.now() - drainStarted) / 1000 : null;

  const violations = Number(
    await input.scalar(
      `SELECT count(*)::text FROM wallets w
        WHERE w.balance <> (SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
                              FROM wallet_ledger_entries l WHERE l.wallet_id = w.id)
           OR w.balance < 0`,
    ),
  );
  const duplicates = Number(
    await input.scalar(
      `SELECT count(*)::text FROM (SELECT external_transaction_id FROM wager_transactions
         GROUP BY external_transaction_id HAVING count(*) > 1) d`,
    ),
  );

  const answered = samples.filter((sample) => sample.outcome !== 'LOST');
  const latencies = sortedLatencies(answered);
  const distinctLatencies = sortedLatencies(answered.filter((sample) => !sample.hot));
  const hotLatencies = sortedLatencies(answered.filter((sample) => sample.hot));
  const lost = samples.length - answered.length;
  const serverErrors = samples.filter(
    (sample) =>
      sample.outcome === 'LOST' || (typeof sample.outcome === 'number' && sample.outcome >= 500),
  ).length;
  const statusMix: Record<string, number> = {};
  const lostReasons: Record<string, number> = {};
  for (const sample of samples) {
    const key = String(sample.outcome);
    statusMix[key] = (statusMix[key] ?? 0) + 1;
    if (sample.lostReason !== undefined) {
      lostReasons[sample.lostReason] = (lostReasons[sample.lostReason] ?? 0) + 1;
    }
  }
  const sortedLags = [...lags].sort((left, right) => left - right);
  const lagP99Ms = percentile(sortedLags, 0.99);
  const errorRate = samples.length === 0 ? 1 : serverErrors / samples.length;
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);

  const reasons = stepReasons({
    lost,
    errorRate,
    p95,
    p99,
    lagP99Ms,
    drainSeconds,
    violations,
    duplicates,
    incorrect: incorrectAnswers(samples),
    peakRssMiB: Object.fromEntries(peakRssMiB),
  });

  return {
    rate,
    seconds,
    elapsedSeconds: cpu.elapsedSeconds,
    sent: samples.length,
    answered: answered.length,
    lost,
    serverErrors,
    errorRate,
    maxInFlight,
    p50: finite(percentile(latencies, 0.5)),
    p95: finite(p95),
    p99: finite(p99),
    max: finite(latencies.at(-1) ?? Number.NaN),
    distinctP99: finite(percentile(distinctLatencies, 0.99)),
    hotP99: finite(percentile(hotLatencies, 0.99)),
    lagP99Ms: finite(lagP99Ms),
    maxLagMs: finite(Math.max(0, ...lags)),
    drainSeconds,
    violations,
    duplicates,
    eventsCreated,
    lockWaitersMean: mean(lockWaiters),
    lockWaitersMax: Math.max(0, ...lockWaiters),
    idleInTransactionMean: mean(idleInTransaction),
    idleInTransactionMax: Math.max(0, ...idleInTransaction),
    connectionsMax: sessionsMax,
    cpuPercent: cpu.cpuPercent,
    generatorCpuPercent: finite(cpu.generatorCpuPercent),
    peakRssMiB: Object.fromEntries(peakRssMiB),
    statusMix,
    lostReasons,
    byKind: kindRecords(samples),
    reasons,
  };
}

/**
 * The plan of this run. The parent process computes it, from the host and LOAD_CPUS, and the generator
 * re-launches itself under taskset with the same plan in its environment.
 */
async function launch(): Promise<number> {
  // Re-renders the report from the run records already in LOAD_RESULTS_DIR. Nothing is measured and no run is
  // written, so the committed results stay as they were measured.
  if (env.LOAD_REPORT_ONLY === '1') {
    const runs = await readRuns(RESULTS_DIR);
    await writeFile(REPORT_PATH, renderReport(runs, new Date().toISOString()));
    console.log(`report re-rendered from ${runs.length} runs in ${RESULTS_DIR}: ${REPORT_PATH}`);
    return 0;
  }
  const pinnable = platform() === 'linux';
  const allowed = await allowedCpus();
  const stackCount = env.LOAD_CPUS === undefined ? allowed.length : Number(env.LOAD_CPUS);
  if (!pinnable && stackCount !== allowed.length) {
    throw new Error('LOAD_CPUS needs Linux, where the stack can be pinned. Leave it unset here.');
  }
  const planned = env[PLAN_MARK] === undefined;
  const plan: PinningPlan = planned
    ? planPinning({ allowed, stackCount, pinnable })
    : planFromEnvironment(env[PLAN_MARK] ?? '');

  if (planned) {
    // The generator always runs in a child: the in-flight limit must be set before the runtime starts.
    // The child is pinned to the CPUs the stack does not use, when there are any.
    const pinnedGenerator = plan.generator.length > 0;
    const command = [
      ...(pinnedGenerator ? ['taskset', '-c', formatCpuList(plan.generator)] : []),
      process.execPath,
      'run',
      import.meta.path,
    ];
    const child = Bun.spawn(command, {
      env: {
        ...env,
        [PLAN_MARK]: JSON.stringify({
          pinned: plan.pinned,
          allowed: formatCpuList(plan.allowed),
          stack: formatCpuList(plan.stack),
          generator: formatCpuList(plan.generator),
        }),
        // Raised so that the generator never queues its own requests. The in-flight column shows the count.
        BUN_CONFIG_MAX_HTTP_REQUESTS: env.BUN_CONFIG_MAX_HTTP_REQUESTS ?? '1024',
      },
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return child.exited;
  }
  return runLoad(plan);
}

function planFromEnvironment(text: string): PinningPlan {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('pinned' in parsed) ||
    !('allowed' in parsed) ||
    !('stack' in parsed) ||
    !('generator' in parsed) ||
    typeof parsed.pinned !== 'boolean' ||
    typeof parsed.allowed !== 'string' ||
    typeof parsed.stack !== 'string' ||
    typeof parsed.generator !== 'string'
  ) {
    throw new Error(`${PLAN_MARK} is not a pinning plan`);
  }
  const allowed = parseCpuList(parsed.allowed);
  return {
    pinned: parsed.pinned,
    hostLogicalCpus: allowed.length,
    allowed,
    stack: parseCpuList(parsed.stack),
    generator: parseCpuListOrNone(parsed.generator),
  };
}

process.exitCode = await launch();
