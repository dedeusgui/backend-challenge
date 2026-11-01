/**
 * Renders docs/LOAD_TEST_RESULTS.md from the run records, one per CPU count. The figures are computed
 * here from the records, so a run is never summarised by hand.
 */
import { cpuMicrosPerRequest, netPercent, predictedCeiling, utilisation } from './metrics';
import type { RunRecord, StepRecord } from './records';
import { WORKLOAD_KINDS } from './workload';

/** The stack components, in the order of the CPU table. The keys are the names the driver records. */
const COMPONENTS = [
  ['api-1', 'api-1'],
  ['api-2', 'api-2'],
  ['api-3', 'api-3'],
  ['worker-1', 'worker-1'],
  ['worker-2', 'worker-2'],
  ['postgres', 'PostgreSQL'],
  ['localstack', 'LocalStack'],
] as const;

/** A number for a table cell, or `n/a` when the value is missing. Never NaN, null or undefined. */
function na(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? 'n/a'
    : value.toFixed(digits);
}

function percent(value: number, digits = 0): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'n/a';
}

/** Net CPU of each stack component, after the idle baseline of the run is taken away. */
function netByComponent(step: StepRecord, idle: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(step.cpuPercent).map(([name, gross]) => [name, netPercent(gross, idle[name])]),
  );
}

interface StepFigures {
  netStackPercent: number;
  cpuMicros: number;
  utilisation: number;
  ceiling: number;
}

function figuresOf(run: RunRecord, step: StepRecord): StepFigures {
  const netStackPercent = Object.values(netByComponent(step, run.idle.cpuPercent)).reduce(
    (sum, value) => sum + value,
    0,
  );
  const cpuMicros = cpuMicrosPerRequest({
    netStackPercent,
    elapsedSeconds: step.elapsedSeconds,
    answered: step.answered,
  });
  return {
    netStackPercent,
    cpuMicros,
    utilisation: utilisation({ netStackPercent, stackCpus: run.stackCpus }),
    ceiling: predictedCeiling({ stackCpus: run.stackCpus, cpuMicros }),
  };
}

/** The step that passed, at the agreed rate. Undefined when no step passed. */
function agreedStepOf(run: RunRecord): StepRecord | undefined {
  return run.steps.find((step) => step.rate === run.agreedRate && step.reasons.length === 0);
}

function firstFailingStepOf(run: RunRecord): StepRecord | undefined {
  return run.steps.find((step) => step.reasons.length > 0);
}

function statusText(statuses: Record<string, number>): string {
  return Object.entries(statuses)
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ');
}

function capacityRow(run: RunRecord): string {
  const failing = firstFailingStepOf(run);
  const why = failing === undefined ? '-' : failing.reasons.join('; ');
  const firstFailing = run.firstFailingRate === null ? '-' : String(run.firstFailingRate);
  const agreed = agreedStepOf(run);
  if (run.agreedRate === null || agreed === undefined) {
    return `| ${run.stackCpus} | none | - | - | - | - | ${firstFailing} | ${why} |`;
  }
  const figures = figuresOf(run, agreed);
  return `| ${run.stackCpus} | ${run.agreedRate} | ${(run.agreedRate / run.stackCpus).toFixed(1)} | ${na(figures.cpuMicros, 0)} | ${percent(figures.utilisation)} | ${na(figures.ceiling, 0)} | ${firstFailing} | ${why} |`;
}

function capacitySection(runs: readonly RunRecord[]): string {
  const rows = runs.map(capacityRow).join('\n');
  return `## Capacity by CPU count

The same stack, with the same processes and the same workload, on 1, 2 and more CPUs. The agreed rate is
the highest step that passed every constraint. Per stack CPU is that rate divided by the CPUs given to the
stack. CPU per request is the stack's CPU beyond its idle baseline, divided by the requests it answered,
at the agreed rate. Utilisation is the share of the stack's CPUs that it used. The predicted ceiling is the
rate at which the same CPU per request would use every CPU given to the stack. It is a prediction from one
step, to be compared with the first failing rate, not a measurement.

| Stack CPUs | Agreed rate (req/s) | Per stack CPU (req/s) | CPU µs per request | Utilisation at the agreed rate | Predicted ceiling at full use (req/s) | First failing rate (req/s) | Why it failed |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows}
`;
}

function constraintsSection(runs: readonly RunRecord[]): string {
  const first = runs[0];
  if (first === undefined) return '## Constraints and workload\n\nNo run.\n';
  const same = runs.every(
    (run) => JSON.stringify(run.constraints) === JSON.stringify(first.constraints),
  );
  const constraints = first.constraints;
  const total = Object.values(first.workload.planned).reduce((sum, value) => sum + value, 0);
  const mix = WORKLOAD_KINDS.map((kind) => {
    const planned = first.workload.planned[kind] ?? 0;
    return `| ${kind} | ${first.workload.mixPercent[kind] ?? 0}% | ${percent(planned / total, 1)} |`;
  }).join('\n');
  return `## Constraints and workload

${same ? 'Every run used the constraints below.' : 'The runs used different constraints. Each run section shows its own steps and verdicts.'}

| Constraint | Value |
| --- | --- |
| Error rate (5xx and lost, over requests sent) | at most ${constraints.maxErrorRate * 100}% |
| Lost requests (no HTTP response within ${constraints.requestTimeoutMs / 1000} s) | at most ${constraints.maxLostRequests} |
| p95 latency, answered requests | at most ${constraints.maxP95Ms} ms |
| p99 latency, answered requests | at most ${constraints.maxP99Ms} ms |
| Generator lag behind the schedule, p99 | at most ${constraints.maxGeneratorLagP99Ms} ms |
| Outbox drained after the step | within ${constraints.maxOutboxDrainSeconds} s |
| Resident memory of any one process | at most ${constraints.maxRssMiBPerProcess} MiB |
| Balance equals the ledger, and no balance below zero | every wallet, every step |
| A transaction processed twice (by provider and external id, and by provider and idempotency key) | none |
| Answers the contract does not allow for the request that got them | none |

Each step lasts ${constraints.stepSeconds} seconds. The mix is a share of all operations, configured in
\`test/load/thresholds.ts\` and realised by \`test/load/workload.ts\`:

| Operation | Configured share | Realised share |
| --- | ---: | ---: |
${mix}

Over ${first.workload.wallets} wallets, ${percent(first.workload.hotShare)} of the bets go to one hot wallet.
A bet is ${first.workload.stake} BRL, a win is ${first.workload.winAmount} BRL, a loss carries no amount.
A settlement, refund or rollback is sent ${first.workload.settleAfterOperations} operations after its bet,
a read ${first.workload.readAfterOperations} operations after it, a replay ${first.workload.replayAfterOperations}
operations after it.
`;
}

const LIMITS = [
  'It proves that the stack kept its constraints for the length of one step, at one rate, on the CPUs given to it. It does not prove a rate for longer than a step: there is no soak test.',
  'The CPU counts are the CPUs given to the stack with `taskset` and with the cpuset of each container. The number of processes does not change with the CPU count: the API processes, the workers, one PostgreSQL and one LocalStack, as the environment table gives them. A machine with more CPUs gives the same processes more room; it does not add processes.',
  'The generator runs on the CPUs the stack does not use. When the stack has every CPU of the host, the generator shares them, and its CPU is in the table. A shared generator makes the figures pessimistic, not optimistic.',
  'The queue is LocalStack, not AWS SQS. Its CPU is counted in the stack, and its cost is not the cost of AWS SQS.',
  'PostgreSQL runs with its default configuration, on local disk, with no replica and no tuning.',
  'The mix is ours, and it goes through HTTP only. Providers that send operations through the command queue are not in it; the concurrency tests cover that path. The shares are in the constraints section, and the realised shares are the ones the run sent.',
  'Latency is the client view, measured from the scheduled send time. The percentiles come from our own sample, not from a histogram.',
  "An answer is judged against the request it answers, and against what the client knew when it sent that request. A business answer that the run's concurrency makes possible (a replay, a reference still pending, a read that raced its write) is counted as concurrent, and it is not a failure. Any other answer that the contract does not allow is incorrect, and a step with one fails, whatever its latency. Errors, for the error rate, are 5xx answers and requests that got no response.",
  'CPU is read from /proc for each process, and from `docker stats` for each container. The container figure is a sample, not a cumulative counter. Each component is taken above its own idle baseline, measured with no traffic before the ramp.',
  'CPU per request is the whole stack divided by the requests answered. It is not a cost per operation type: the CPU of an operation cannot be separated from the others it shares a process with.',
  'Each step ran once. There is no confidence interval, and the same rate on another run can land on the other side of a constraint.',
  'Pinning needs Linux (`taskset`, `/proc`, and docker with cpuset). On macOS the run is not pinned and the report says so. On Windows, run it inside WSL.',
  'The numbers describe the machine that ran them. Do not compare a number from another machine without the environment table next to it.',
]
  .map((line) => `- ${line}`)
  .join('\n');

/**
 * The four times the run measured, each with its unit. They are different things, and the report does not add
 * them up: HTTP latency is the client's wait for an answer; generator lag is how late a request was sent;
 * outbox lag is how long a committed event waited before the worker sent it; outbox drain is how long the
 * events of a step took to reach the queue after the step.
 */
function lagSection(run: RunRecord, agreed: StepRecord | undefined): string {
  const na3 = (value: number | undefined): string =>
    value === undefined ? 'n/a' : value.toFixed(3);
  const at = (value: number | null | undefined): string => na(value ?? null);
  const phase = (name: string) => run.phases?.[name];
  const lag = phase('outbox_lag_seconds');
  const claim = phase('outbox_claim_ms');
  const publish = phase('outbox_publish_ms');
  const maxLag = Math.max(0, ...run.steps.map((step) => step.maxLagMs ?? 0));
  const atAgreed =
    agreed === undefined
      ? undefined
      : {
          p50: agreed.p50 ?? undefined,
          p95: agreed.p95 ?? undefined,
          p99: agreed.p99 ?? undefined,
          lagP99: agreed.lagP99Ms ?? undefined,
          drain: agreed.drainSeconds ?? undefined,
        };
  if (run.phases === undefined) {
    return `#### Latency, lag and drain\n\nThe phases of this run were not measured: the run was made before they were recorded.`;
  }
  const rowsAtAgreed = [
    `| HTTP latency, p50 / p95 / p99 | ms | ${atAgreed === undefined ? 'n/a' : `${at(atAgreed.p50)} / ${at(atAgreed.p95)} / ${at(atAgreed.p99)}`} | client view, answered requests of the step |`,
    `| Generator lag, p99 | ms | ${at(atAgreed?.lagP99)} | how late the generator sent its requests |`,
    `| Generator lag, max over the steps | ms | ${na(maxLag)} | the largest single lag of any step |`,
    `| Outbox drain after the step | s | ${na3(atAgreed?.drain)} | from the end of the step until no event is unpublished |`,
  ];
  const rowsWholeRun = [
    `| Outbox lag, commit to send | s | ${lag?.count ?? 'n/a'} | ${na3(lag?.mean)} | ${na3(lag?.max)} | measured by the worker per event, over the whole run; no percentile of the outbox lag is measured |`,
    `| Outbox claim, one claim of due events | ms | ${claim?.count ?? 'n/a'} | ${na(claim?.mean ?? null)} | ${na(claim?.max ?? null)} | the claim statement of the publisher |`,
    `| Outbox publish, one claimed batch | ms | ${publish?.count ?? 'n/a'} | ${na(publish?.mean ?? null)} | ${na(publish?.max ?? null)} | the send of a claimed batch (up to the outbox batch size) to the events queue, in requests of up to ten |`,
  ];
  return `#### Latency, lag and drain

The four times are different, and the report does not add them up. The first two tables are at the agreed step.
The last is over the whole run, where the workers keep a count, a mean and a maximum, and no percentile.

| Measure | Unit | Value | Note |
| --- | --- | ---: | --- |
${rowsAtAgreed.join('\n')}

| Measure | Unit | Count | Mean | Max | Note |
| --- | --- | ---: | ---: | ---: | --- |
${rowsWholeRun.join('\n')}`;
}

function runSection(run: RunRecord): string {
  const cpus = `${run.stackCpus} stack CPU${run.stackCpus === 1 ? '' : 's'}`;
  const pinning = run.pinned
    ? `The stack ran on CPUs ${run.stackCpuList}. The generator ${
        run.generatorCpuList === null
          ? 'shared the same CPUs, because the stack had all of them'
          : `ran on CPUs ${run.generatorCpuList}`
      }.`
    : `The stack was not pinned: it and the generator shared all ${run.hostLogicalCpus} logical CPUs.`;
  const agreed = agreedStepOf(run);
  const failing = firstFailingStepOf(run);
  const verdict =
    agreed === undefined
      ? '**No step passed every constraint.** The lowest rate already breaks at least one constraint.'
      : `**Agreed rate: ${run.agreedRate} requests per second.** It is the highest step that passed every constraint, held for ${run.steps[0]?.seconds ?? 0} seconds.`;
  const failure =
    failing === undefined
      ? 'No step failed. The ramp reached its last rate.'
      : `First failing step: ${failing.rate} requests per second. It broke: ${failing.reasons.join('; ')}.`;

  const latency = run.steps
    .map(
      (step) =>
        `| ${step.rate} | ${step.sent} | ${step.lost} | ${step.serverErrors} | ${(step.errorRate * 100).toFixed(3)}% | ${na(step.p50)} | ${na(step.p95)} | ${na(step.p99)} | ${na(step.distinctP99)} | ${na(step.hotP99)} | ${na(step.max)} | ${step.reasons.length === 0 ? 'PASS' : 'FAIL'} |`,
    )
    .join('\n');

  const resources = run.steps
    .map((step) => {
      const figures = figuresOf(run, step);
      const largest = Math.max(0, ...Object.values(step.peakRssMiB));
      const drain = step.drainSeconds === null ? 'not drained' : na(step.drainSeconds);
      return `| ${step.rate} | ${na(figures.netStackPercent, 0)} | ${percent(figures.utilisation)} | ${na(figures.cpuMicros, 0)} | ${na(step.generatorCpuPercent, 0)} | ${step.maxInFlight} | ${na(step.lagP99Ms)} | ${drain} | ${step.eventsCreated} | ${na(step.lockWaitersMean)} / ${step.lockWaitersMax} | ${na(step.idleInTransactionMean)} / ${step.idleInTransactionMax} | ${step.connectionsMax} | ${na(largest, 0)} |`;
    })
    .join('\n');

  const cpuCells = (values: Record<string, number>): string =>
    COMPONENTS.map(([key]) => na(values[key], 0)).join(' | ');
  const idleRow = `| Idle, ${run.idle.seconds} s | ${cpuCells(run.idle.cpuPercent)} | n/a |`;
  const cpuRows = run.steps
    .map((step) => {
      const net = netByComponent(step, run.idle.cpuPercent);
      return `| ${step.rate} | ${cpuCells(net)} | ${na(step.generatorCpuPercent, 0)} |`;
    })
    .join('\n');

  const focus = agreed ?? run.steps.at(-1);
  const kinds =
    focus === undefined
      ? 'No step ran.'
      : WORKLOAD_KINDS.filter((kind) => focus.byKind[kind] !== undefined)
          .map((kind) => {
            const row = focus.byKind[kind];
            if (row === undefined) return '';
            return `| ${kind} | ${row.sent} | ${row.answered} | ${row.unexpected} | ${row.concurrent ?? 'n/a'} | ${na(row.p50)} | ${na(row.p95)} | ${na(row.p99)} | ${statusText(row.statuses)} |`;
          })
          .join('\n');
  const kindHeading =
    agreed === undefined
      ? '#### Latency by operation at the last step run'
      : '#### Latency by operation at the agreed rate';

  const lost = run.steps.flatMap((step) =>
    Object.entries(step.lostReasons).map(
      ([reason, count]) => `| ${step.rate} | ${reason} | ${count} |`,
    ),
  );
  const peak = new Map<string, number>();
  const mix = new Map<string, number>();
  for (const step of run.steps) {
    for (const [name, mib] of Object.entries(step.peakRssMiB)) {
      peak.set(name, Math.max(peak.get(name) ?? 0, mib));
    }
    for (const [status, count] of Object.entries(step.statusMix)) {
      mix.set(status, (mix.get(status) ?? 0) + count);
    }
  }

  return `### ${cpus}

${pinning}

${verdict}

${failure}

#### Steps: latency and errors

Latency is in milliseconds, from the scheduled send time, over the answered requests of the step.

| Rate (req/s) | Sent | Lost | 5xx or lost | Error rate | p50 | p95 | p99 | Distinct-wallet p99 | Hot-wallet p99 | max | Verdict |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${latency}

#### Steps: CPU, queue and database

The CPU of the stack is the sum of its components above their idle baseline, in percent of one CPU.
Lock waiters are the sessions that waited on a lock, and sessions idle in a transaction are those that
were between two statements of their transaction, both sampled every 200 ms during the step. A session
idle in a transaction is the API doing something other than waiting on the database. Connections are the
sessions open in PostgreSQL, including the few that the load test itself holds. Events created are the
outbox rows the step wrote.

| Rate (req/s) | Stack CPU, net (%) | Utilisation | CPU µs per request | Generator CPU (%) | Max in flight | Lag p99 (ms) | Outbox drain (s) | Events created | Lock waiters mean / max | Idle in transaction mean / max | Connections max | Largest process RSS (MiB) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${resources}

#### CPU by component

Each API process and each worker is one Bun process, which runs on one thread, so its CPU cannot pass 100%
of one CPU. PostgreSQL and LocalStack are containers. The idle row is the baseline that each component is
taken above; the step rows are net of it.

| Rate (req/s) | ${COMPONENTS.map(([, label]) => label).join(' | ')} | Generator (%) |
| ---: | ${COMPONENTS.map(() => '---:').join(' | ')} | ---: |
${idleRow}
${cpuRows}

${kindHeading}

| Operation | Sent | Answered | Incorrect answers | Concurrent answers | p50 (ms) | p95 (ms) | p99 (ms) | Statuses |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${kinds}

${lagSection(run, agreed)}

#### Lost requests

| Rate (req/s) | Error | Count |
| ---: | --- | ---: |
${lost.length === 0 ? '| none | | 0 |' : lost.join('\n')}

#### Memory, statuses and environment

Peak resident memory of each process over the run.

| Process | Peak RSS (MiB) |
| --- | ---: |
${[...peak].map(([name, mib]) => `| ${name} | ${na(mib, 0)} |`).join('\n')}

Status mix over every step of the run.

| Status | Count |
| --- | ---: |
${[...mix].map(([status, count]) => `| ${status} | ${count} |`).join('\n')}

| Item | Value |
| --- | --- |
| Platform | ${run.environment.platform} ${run.environment.release} (${run.environment.arch}) |
| CPU | ${run.environment.cpuModel} |
| Logical CPUs on the host | ${run.hostLogicalCpus} |
| CPUs given to the stack | ${run.stackCpuList} |
| CPUs given to the generator | ${run.generatorCpuList ?? 'shared with the stack'} |
| Observed affinity (from /proc) | ${
    Object.entries(run.observedAffinity)
      .map(([name, list]) => `${name} ${list}`)
      .join(', ') || 'not read'
  } |
| Container cpusets | ${
    Object.entries(run.containerCpusets)
      .map(([name, list]) => `${name} ${list}`)
      .join(', ') || 'not pinned'
  } |
| Memory | ${run.environment.memoryGiB.toFixed(1)} GiB |
| Bun | ${run.environment.bun} |
| Processes | ${run.environment.topology} |
| Concurrency conflicts: wallet-lock races lost and retried, all API processes, whole run | ${run.concurrencyConflicts} |
`;
}

/** The dates the runs were measured on, from their own records, so the report never claims a later date. */
function measuredOn(runs: readonly RunRecord[]): string {
  if (runs.length === 0) return 'no run';
  return runs
    .map((run) => `${run.stackCpus} CPU${run.stackCpus === 1 ? '' : 's'} at ${run.generatedAt}`)
    .join('; ');
}

export function renderReport(runs: readonly RunRecord[], generatedAt: string): string {
  const sorted = [...runs].sort((left, right) => left.stackCpus - right.stackCpus);
  const sections = sorted.map(runSection).join('\n');
  return `# Load test results

Rendered on ${generatedAt} from the run records below, which were measured on ${measuredOn(runs)}. One run per CPU count, each in
\`docs/load/results/cpus-<N>.json\`. The method is in \`DECISIONS.md\`, group N. The constraints and the
workload are in \`test/load/thresholds.ts\`. The local baseline, with 13 scenarios measured on another host, is in
\`docs/LOAD_TEST_BASELINE.en.md\`, and its records are in \`docs/load/local/\`. It is not an improvement over the runs
below, because the hosts differ.

${capacitySection(sorted)}
${constraintsSection(sorted)}
## What these numbers prove, and what they do not

${LIMITS}

## Runs

${sections}
## Definitions

- **Sent**: a request the generator put on the wire at its scheduled time.
- **Answered**: a request that received an HTTP response of any status.
- **Lost**: a request that received no response: a timeout, or a connection that closed.
- **Error**: a 5xx answer, or a lost request. It is the error rate of a step.
- **Incorrect answer**: an answer the contract does not allow for that request, given what the client knew when it sent it. Examples: a 422 to a settlement (the planner sends none the API must refuse), a 404 to a read of a BET the client had seen applied, a 202 to a settlement of such a BET. A step with one fails.
- **Concurrent answer**: a valid business answer that the run's concurrency makes possible: a 200 replay of a BET, a 202 reference pending or a 404 read while the BET was still in flight. It is counted, and it does not fail a step.
- **Primary answer**: the status the request gets when it does its job (201 for a bet or a settlement, 200 for a replay or a read).
- **Generator lag**: how late the generator sent a request compared with its schedule.
- **CPU µs per request**: the stack's CPU above its idle baseline, in microseconds, divided by the requests answered.

## How to reproduce

\`\`\`bash
bun run infra:up
bun run test:load                     # every CPU, the stack not pinned from the generator
LOAD_CPUS=2 bun run test:load         # the stack on two CPUs; the generator on the others
\`\`\`

Each run writes its \`cpus-<N>.json\` again and then this report from every file in the directory.
To render this report again from the records, without measuring anything, run \`LOAD_REPORT_ONLY=1 bun run test:load\`.
For a quick check, use \`LOAD_RATES=25,50 LOAD_STEP_SECONDS=3\`, and point \`LOAD_RESULTS_DIR\` and
\`LOAD_REPORT_PATH\` at a scratch directory, so that the committed results are not overwritten.
`;
}
