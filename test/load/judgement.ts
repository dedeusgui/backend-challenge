/**
 * The judgement of a load step, as pure functions: which answer each request may get, which answers are
 * wrong, and which constraints a step breaks. The runner calls these, and the unit tests call the same
 * functions, so a rule is tested where it is applied.
 *
 * A status is judged against the request it answers, and against what the client already knew when it
 * sent that request. A reply to a settlement whose BET had been acknowledged before the settlement was sent
 * must be the applied one (201). A reply to a settlement sent while its BET was still in flight may be
 * 202, the reference pending: the API holds the operation and says so. The same holds for a read: it may
 * be 404 only while the write it reads is still in flight. A rejection (409, 422) or a server error is
 * never acceptable: the planner sends no operation that the API must refuse.
 */
import { LOAD_THRESHOLDS } from './thresholds';
import type { PlannedOperation, WorkloadKind } from './workload';

/** How long the runner waits for the outbox to drain before it reports that it did not. */
export const DRAIN_CAP_SECONDS = 120;

export interface AnswerContext {
  readonly kind: WorkloadKind;
  /**
   * For a request that depends on a BET: whether the BET was already applied (answered 201 or 200) when this
   * request was sent. Undefined for a request that depends on nothing.
   */
  readonly dependencyApplied?: boolean;
}

/** The answers the API may give to a request, the first being the one it gives when the request does its job. */
export function acceptableAnswers(context: AnswerContext): readonly number[] {
  switch (context.kind) {
    case 'BET':
      // 200 is a replay: an identical request reached the API first, which the planner can cause by reordering.
      return [201, 200];
    case 'READ_WALLET':
      return [200];
    case 'REPLAY':
      return context.dependencyApplied === true ? [200] : [200, 201];
    case 'READ_TRANSACTION':
      return context.dependencyApplied === true ? [200] : [200, 404];
    case 'WIN':
    case 'LOSS':
    case 'REFUND':
    case 'ROLLBACK':
      return context.dependencyApplied === true ? [201] : [201, 202];
  }
}

/** The status a request gets when it does its job. */
export function primaryAnswer(kind: WorkloadKind): number {
  return kind === 'BET' ||
    kind === 'WIN' ||
    kind === 'LOSS' ||
    kind === 'REFUND' ||
    kind === 'ROLLBACK'
    ? 201
    : 200;
}

export type AnswerClass = 'expected' | 'concurrent' | 'incorrect' | 'lost';

export interface AnswerFacts {
  readonly kind: WorkloadKind;
  readonly outcome: number | 'LOST';
  readonly primary: number;
  readonly acceptable: readonly number[];
}

/**
 * expected: the answer the request should get. concurrent: a valid business answer that the concurrency of
 * the run made possible (a replay, a reference pending, a read that raced its write). incorrect: anything
 * else, which means the contract was broken. lost: no answer at all.
 */
export function classifyAnswer(facts: AnswerFacts): AnswerClass {
  if (facts.outcome === 'LOST') return 'lost';
  if (facts.outcome === facts.primary) return 'expected';
  return facts.acceptable.includes(facts.outcome) ? 'concurrent' : 'incorrect';
}

/** The BET a request depends on, if it depends on one. */
export function dependencyOf(operation: PlannedOperation): string | undefined {
  return operation.kind === 'BET' || operation.kind === 'READ_WALLET'
    ? undefined
    : operation.bet.externalId;
}

/** The BET a request applies when it is answered, if it applies one. */
export function appliedBy(operation: PlannedOperation, status: number): string | undefined {
  const applies = status === 200 || status === 201;
  return applies && (operation.kind === 'BET' || operation.kind === 'REPLAY')
    ? operation.bet.externalId
    : undefined;
}

export interface IncorrectAnswer {
  readonly kind: WorkloadKind;
  readonly status: number;
  readonly count: number;
}

/** The wrong answers of a step, by kind and status, in the order the kinds are planned. */
export function incorrectAnswers(samples: readonly AnswerFacts[]): IncorrectAnswer[] {
  const counts = new Map<string, IncorrectAnswer>();
  for (const sample of samples) {
    if (classifyAnswer(sample) !== 'incorrect' || sample.outcome === 'LOST') continue;
    const key = `${sample.kind} ${sample.outcome}`;
    const current = counts.get(key);
    counts.set(key, {
      kind: sample.kind,
      status: sample.outcome,
      count: (current?.count ?? 0) + 1,
    });
  }
  return [...counts.values()];
}

/** The figures of a step that its constraints are checked against. */
export interface StepFacts {
  lost: number;
  errorRate: number;
  p95: number;
  p99: number;
  lagP99Ms: number;
  drainSeconds: number | null;
  violations: number;
  duplicates: number;
  incorrect: readonly IncorrectAnswer[];
  peakRssMiB: Readonly<Record<string, number>>;
}

/**
 * Every constraint the step breaks, in words. A step with no reason passed. The constraints are the ones of
 * LOAD_THRESHOLDS, and no threshold is loosened here: an incorrect answer fails a step whatever its latency.
 */
export function stepReasons(facts: StepFacts): string[] {
  const reasons: string[] = [];
  const { lost, errorRate, p95, p99, lagP99Ms, drainSeconds } = facts;
  if (lost > LOAD_THRESHOLDS.maxLostRequests) {
    reasons.push(`${lost} requests lost (max ${LOAD_THRESHOLDS.maxLostRequests})`);
  }
  if (errorRate > LOAD_THRESHOLDS.maxErrorRate) {
    reasons.push(
      `error rate ${(errorRate * 100).toFixed(3)}% (max ${LOAD_THRESHOLDS.maxErrorRate * 100}%)`,
    );
  }
  if (!(p95 <= LOAD_THRESHOLDS.maxP95Ms)) {
    reasons.push(`p95 ${p95.toFixed(1)} ms (max ${LOAD_THRESHOLDS.maxP95Ms})`);
  }
  if (!(p99 <= LOAD_THRESHOLDS.maxP99Ms)) {
    reasons.push(`p99 ${p99.toFixed(1)} ms (max ${LOAD_THRESHOLDS.maxP99Ms})`);
  }
  if (!(lagP99Ms <= LOAD_THRESHOLDS.maxGeneratorLagP99Ms)) {
    reasons.push(
      `generator lag p99 ${lagP99Ms.toFixed(1)} ms (max ${LOAD_THRESHOLDS.maxGeneratorLagP99Ms})`,
    );
  }
  if (drainSeconds === null || !(drainSeconds <= LOAD_THRESHOLDS.maxOutboxDrainSeconds)) {
    reasons.push(
      `outbox drained in ${drainSeconds === null ? `more than ${DRAIN_CAP_SECONDS} s` : `${drainSeconds.toFixed(1)} s`} (max ${LOAD_THRESHOLDS.maxOutboxDrainSeconds})`,
    );
  }
  if (facts.violations > 0) {
    reasons.push(`${facts.violations} wallets where balance differs from the ledger`);
  }
  if (facts.duplicates > 0) {
    reasons.push(`${facts.duplicates} transactions processed more than once`);
  }
  const incorrect = facts.incorrect.reduce((sum, answer) => sum + answer.count, 0);
  if (incorrect > LOAD_THRESHOLDS.maxIncorrectAnswers) {
    const detail = facts.incorrect
      .map((answer) => `${answer.kind} ${answer.status} ×${answer.count}`)
      .join(', ');
    reasons.push(`${incorrect} incorrect ${incorrect === 1 ? 'answer' : 'answers'} (${detail})`);
  }
  for (const [name, mib] of Object.entries(facts.peakRssMiB)) {
    if (mib > LOAD_THRESHOLDS.maxRssMiBPerProcess) {
      reasons.push(
        `${name} peaked at ${mib.toFixed(0)} MiB (max ${LOAD_THRESHOLDS.maxRssMiBPerProcess})`,
      );
    }
  }
  return reasons;
}
