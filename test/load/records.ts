import type { PhaseSummary } from './metrics';
/**
 * The record of one load run, one file per CPU count: docs/load/results/cpus-<N>.json. The driver
 * writes it, the report reads it. Plain JSON only: no Map, no NaN. A missing value is null.
 */

export const RUN_FORMAT = 'load-test-run';
export const RUN_VERSION = 1;

export interface KindRecord {
  sent: number;
  answered: number;
  /**
   * Answers the contract does not allow for the request that got them. A step with one fails (thresholds.ts).
   * Runs made before the judgement was counted this way reported these as "unexpected", and failed no step.
   */
  unexpected: number;
  /**
   * Answers that are valid business answers because of the run's concurrency: a reference still pending, a
   * read that raced its write, a replay. Absent in runs made before this count existed.
   */
  concurrent?: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  statuses: Record<string, number>;
}

export interface StepRecord {
  rate: number;
  seconds: number;
  /** Time from the first scheduled send to the last answer, the window the CPU is measured over. */
  elapsedSeconds: number;
  sent: number;
  answered: number;
  lost: number;
  serverErrors: number;
  errorRate: number;
  maxInFlight: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  distinctP99: number | null;
  hotP99: number | null;
  lagP99Ms: number | null;
  maxLagMs: number | null;
  /** Null when the outbox did not drain within the cap. */
  drainSeconds: number | null;
  violations: number;
  duplicates: number;
  eventsCreated: number;
  lockWaitersMean: number | null;
  lockWaitersMax: number;
  /** Sessions in PostgreSQL that were idle inside a transaction: the API was between two statements. */
  idleInTransactionMean: number | null;
  idleInTransactionMax: number;
  connectionsMax: number;
  /** Gross CPU of each stack component during the step, in percent of one CPU. */
  cpuPercent: Record<string, number>;
  generatorCpuPercent: number | null;
  peakRssMiB: Record<string, number>;
  statusMix: Record<string, number>;
  lostReasons: Record<string, number>;
  byKind: Record<string, KindRecord>;
  reasons: string[];
}

export interface RunRecord {
  format: typeof RUN_FORMAT;
  version: typeof RUN_VERSION;
  generatedAt: string;
  /** CPUs given to the stack. Also the number in the file name. */
  stackCpus: number;
  /** The CPU list the stack was pinned to, or `all` when the stack was not pinned. */
  stackCpuList: string;
  /** The CPU list of the generator, or null when it shares the CPUs with the stack. */
  generatorCpuList: string | null;
  pinned: boolean;
  hostLogicalCpus: number;
  /**
   * Where the stack spent its time, summed over the API processes and the workers, from their summaries
   * at the end of the run. Absent in runs made before the phases were measured.
   */
  phases?: Record<string, PhaseSummary>;
  /** The CPU list each process was allowed to run on, read from /proc at the start of the ramp. */
  observedAffinity: Record<string, string>;
  /** The cpuset each container was given during the run. */
  containerCpusets: Record<string, string>;
  environment: {
    platform: string;
    release: string;
    arch: string;
    cpuModel: string;
    memoryGiB: number;
    bun: string;
    topology: string;
  };
  constraints: {
    stepSeconds: number;
    requestTimeoutMs: number;
    maxErrorRate: number;
    maxLostRequests: number;
    maxP95Ms: number;
    maxP99Ms: number;
    maxGeneratorLagP99Ms: number;
    maxOutboxDrainSeconds: number;
    maxRssMiBPerProcess: number;
  };
  workload: {
    mixPercent: Record<string, number>;
    planned: Record<string, number>;
    wallets: number;
    hotShare: number;
    stake: string;
    winAmount: string;
    settleAfterOperations: number;
    readAfterOperations: number;
    replayAfterOperations: number;
  };
  warmup: {
    ratePerSecond: number;
    seconds: number;
    sent: number;
  };
  idle: {
    seconds: number;
    cpuPercent: Record<string, number>;
  };
  steps: StepRecord[];
  agreedRate: number | null;
  firstFailingRate: number | null;
  concurrencyConflicts: number;
  totalSent: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isObject(value) && Object.values(value).every((item) => typeof item === 'number');
}

function isStepRecord(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.rate === 'number' &&
    typeof value.sent === 'number' &&
    typeof value.answered === 'number' &&
    typeof value.elapsedSeconds === 'number' &&
    isNumberRecord(value.cpuPercent) &&
    isNumberRecord(value.statusMix) &&
    isObject(value.byKind) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === 'string')
  );
}

/** Whether a parsed JSON value is a run record of this version. It checks the shape the report relies on. */
export function isRunRecord(value: unknown): value is RunRecord {
  return (
    isObject(value) &&
    value.format === RUN_FORMAT &&
    value.version === RUN_VERSION &&
    typeof value.generatedAt === 'string' &&
    typeof value.stackCpus === 'number' &&
    typeof value.stackCpuList === 'string' &&
    (value.generatorCpuList === null || typeof value.generatorCpuList === 'string') &&
    typeof value.pinned === 'boolean' &&
    typeof value.hostLogicalCpus === 'number' &&
    isObject(value.environment) &&
    isObject(value.constraints) &&
    isObject(value.workload) &&
    isObject(value.warmup) &&
    isObject(value.idle) &&
    Array.isArray(value.steps) &&
    value.steps.every(isStepRecord) &&
    isNullableNumber(value.agreedRate) &&
    isNullableNumber(value.firstFailingRate) &&
    typeof value.concurrencyConflicts === 'number' &&
    typeof value.totalSent === 'number'
  );
}
