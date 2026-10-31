/**
 * Pure arithmetic and parsers for the load test. Nothing here starts a process or reads a file, so
 * every rule of the measurement is tested without a server.
 */

/** Nearest-rank percentile of a sorted sample. Not a number when the sample is empty. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1] ?? Number.NaN;
}

/** Parses a CPU list as /proc and taskset write it: `0-2,5` is CPUs 0, 1, 2 and 5. */
export function parseCpuList(text: string): number[] {
  const cpus: number[] = [];
  for (const part of text.trim().split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (match === null) throw new Error(`not a CPU list: ${text}`);
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (last < first) throw new Error(`not a CPU list: ${text}`);
    for (let cpu = first; cpu <= last; cpu += 1) cpus.push(cpu);
  }
  return cpus;
}

/** Like parseCpuList, but an empty text is no CPUs: the generator has none when the stack has them all. */
export function parseCpuListOrNone(text: string): number[] {
  return text.trim() === '' ? [] : parseCpuList(text);
}

/** Formats CPU ids as the shortest list that taskset and docker accept: [0, 1, 2, 5] is `0-2,5`. */
export function formatCpuList(cpus: readonly number[]): string {
  const sorted = [...new Set(cpus)].sort((left, right) => left - right);
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const cpu of sorted.slice(1)) {
    if (previous !== undefined && cpu === previous + 1) {
      previous = cpu;
      continue;
    }
    if (start !== undefined && previous !== undefined) parts.push(span(start, previous));
    start = cpu;
    previous = cpu;
  }
  if (start !== undefined && previous !== undefined) parts.push(span(start, previous));
  return parts.join(',');
}

function span(first: number, last: number): string {
  return first === last ? String(first) : `${first}-${last}`;
}

/** Clock ticks per second on Linux, where /proc reports CPU time. */
export const LINUX_CLOCK_TICKS = 100;

/**
 * User plus system ticks of a process, from the text of /proc/<pid>/stat. The command name is in
 * parentheses and may contain spaces, so the fields are read after the last closing parenthesis.
 */
export function parseProcStatTicks(stat: string): number {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[11]) + Number(fields[12]);
  if (!Number.isFinite(ticks)) throw new Error('unreadable /proc stat line');
  return ticks;
}

/** A two-column table of `ps -o pid=,<column>=` output, as a map from pid to the value. */
export function parsePidTable(text: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of text.split('\n')) {
    const [pid, value] = line.trim().split(/\s+/).map(Number);
    if (
      pid !== undefined &&
      value !== undefined &&
      Number.isFinite(pid) &&
      Number.isFinite(value)
    ) {
      table.set(pid, value);
    }
  }
  return table;
}

/** Removes the terminal cursor codes (ESC[H, ESC[K, ESC[J) that a streamed docker stats writes. */
export function stripTerminalCodes(text: string): string {
  // The escape byte is the point of this expression, so the control-character rule does not apply.
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** The resident memory of a process in KiB, from the VmRSS line of /proc/<pid>/status. */
export function parseProcStatRssKiB(status: string): number | undefined {
  const line = status.split('\n').find((candidate) => candidate.startsWith('VmRSS:'));
  const kib = Number(line?.split(/\s+/)[1]);
  return line === undefined || !Number.isFinite(kib) ? undefined : kib;
}

/** CPU percent of each container, from `docker stats --format '{{.Name}}\t{{.CPUPerc}}'`. */
export function parseDockerStats(text: string): Map<string, number> {
  const stats = new Map<string, number>();
  for (const line of text.split('\n')) {
    const [name, cpu] = line.split('\t');
    const value = Number.parseFloat(cpu ?? '');
    if (name !== undefined && name !== '' && Number.isFinite(value)) stats.set(name, value);
  }
  return stats;
}

/** A component's use above its idle baseline. Never negative: noise below the baseline is no use. */
export function netPercent(gross: number, idle: number | undefined): number {
  return Math.max(0, gross - (idle ?? 0));
}

/**
 * Microseconds of CPU the stack spent per answered request. `netStackPercent` is the sum over the
 * stack's components of their use above the idle baseline, in percent of one CPU.
 */
export function cpuMicrosPerRequest(input: {
  netStackPercent: number;
  elapsedSeconds: number;
  answered: number;
}): number {
  if (input.answered === 0) return Number.NaN;
  const cpuSeconds = (input.netStackPercent / 100) * input.elapsedSeconds;
  return (cpuSeconds * 1e6) / input.answered;
}

/** Share of the CPUs given to the stack that the stack used, from 0 to 1 and above if the sum is over. */
export function utilisation(input: { netStackPercent: number; stackCpus: number }): number {
  return input.netStackPercent / (input.stackCpus * 100);
}

/**
 * The rate at which the stack would use every CPU it has, if its CPU per request stayed the same.
 * It is a prediction to compare with the measured ceiling, not a measurement.
 */
export function predictedCeiling(input: { stackCpus: number; cpuMicros: number }): number {
  return (input.stackCpus * 1e6) / input.cpuMicros;
}

/** One summary as a process reports it: a count, a sum and a maximum, in one unit. */
export interface SummarySnapshot {
  count: number;
  sum: number;
  max: number;
}

/** A summary over every process of a run: the mean is taken over all their observations together. */
export interface PhaseSummary {
  count: number;
  meanMs: number;
  maxMs: number;
}

/** Adds the summaries of several processes. Counts and sums add up, and the maximum is the largest. */
export function mergeSummaries(
  snapshots: readonly Readonly<Record<string, SummarySnapshot>>[],
): Record<string, PhaseSummary> {
  const merged = new Map<string, { count: number; sum: number; max: number }>();
  for (const snapshot of snapshots) {
    for (const [name, summary] of Object.entries(snapshot)) {
      const current = merged.get(name) ?? { count: 0, sum: 0, max: Number.NEGATIVE_INFINITY };
      merged.set(name, {
        count: current.count + summary.count,
        sum: current.sum + summary.sum,
        max: Math.max(current.max, summary.max),
      });
    }
  }
  return Object.fromEntries(
    [...merged].map(([name, value]) => [
      name,
      { count: value.count, meanMs: value.sum / value.count, maxMs: value.max },
    ]),
  );
}

export function isSummaryRecord(value: unknown): value is Record<string, SummarySnapshot> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Object.values(value).every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'count' in entry &&
      typeof entry.count === 'number' &&
      'sum' in entry &&
      typeof entry.sum === 'number' &&
      'max' in entry &&
      typeof entry.max === 'number',
  );
}

/**
 * The summaries from the last `type: metrics` line a worker printed when it stopped. A worker prints
 * that line on a graceful stop. Undefined when no such line is in the output.
 */
export function summariesFromOutput(output: string): Record<string, SummarySnapshot> | undefined {
  for (const line of output.split('\n').reverse()) {
    if (!line.includes('"type":"metrics"')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const summaries = summariesOfBody(parsed);
    if (summaries !== undefined) {
      return summaries;
    }
  }
  return undefined;
}

/** The summaries in a metrics endpoint answer, or undefined when the answer has none. */
export function summariesOfBody(body: unknown): Record<string, SummarySnapshot> | undefined {
  if (typeof body === 'object' && body !== null && 'summaries' in body) {
    return isSummaryRecord(body.summaries) ? body.summaries : undefined;
  }
  return undefined;
}

function isCounterRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'number')
  );
}

/** The counters in a metrics endpoint answer. An answer without them is a failed run, not zero. */
export function countersOfBody(body: unknown): Record<string, number> {
  if (typeof body === 'object' && body !== null && 'counters' in body) {
    if (isCounterRecord(body.counters)) {
      return body.counters;
    }
  }
  throw new Error('the metrics endpoint answered without counters');
}
