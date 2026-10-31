import { describe, expect, test } from 'bun:test';
import {
  acceptableAnswers,
  appliedBy,
  classifyAnswer,
  DRAIN_CAP_SECONDS,
  dependencyOf,
  incorrectAnswers,
  stepReasons,
  type StepFacts,
} from '../../load/judgement';
import { WORKLOAD_KINDS, type PlannedOperation, type WorkloadKind } from '../../load/workload';

/**
 * The judgement of a load step, pure: which answer a request may get, which answers are wrong, and which
 * constraints a step breaks. The runner calls these functions, so these tests judge the same rules the
 * committed results were judged by.
 */

const SETTLEMENTS: readonly WorkloadKind[] = ['WIN', 'LOSS', 'REFUND', 'ROLLBACK'];

describe('the answers a request may get', () => {
  test('a new BET is applied (201), and an identical request that reached the API first is a replay (200)', () => {
    expect(acceptableAnswers({ kind: 'BET' })).toEqual([201, 200]);
  });

  test('a wallet read is 200, always', () => {
    expect(acceptableAnswers({ kind: 'READ_WALLET' })).toEqual([200]);
  });

  test('a replay whose BET was already applied is 200; while the BET is still in flight, 201 is the first application', () => {
    expect(acceptableAnswers({ kind: 'REPLAY', dependencyApplied: true })).toEqual([200]);
    expect(acceptableAnswers({ kind: 'REPLAY', dependencyApplied: false })).toEqual([200, 201]);
  });

  test('a transaction read after its BET was applied is 200; while the BET is in flight, 404 is a concurrent answer', () => {
    expect(acceptableAnswers({ kind: 'READ_TRANSACTION', dependencyApplied: true })).toEqual([200]);
    expect(acceptableAnswers({ kind: 'READ_TRANSACTION', dependencyApplied: false })).toEqual([
      200, 404,
    ]);
  });

  for (const kind of SETTLEMENTS) {
    test(`a ${kind} after its BET was applied is 201; while the BET is in flight, 202 (reference pending) is a valid answer`, () => {
      expect(acceptableAnswers({ kind, dependencyApplied: true })).toEqual([201]);
      expect(acceptableAnswers({ kind, dependencyApplied: false })).toEqual([201, 202]);
    });
  }

  test('no context accepts a rejection, a conflict, or a server error: those are wrong for every request the planner sends', () => {
    for (const kind of WORKLOAD_KINDS) {
      for (const dependencyApplied of [undefined, true, false]) {
        const answers = acceptableAnswers({ kind, dependencyApplied });
        for (const refused of [409, 422, 500, 503]) {
          expect({ kind, dependencyApplied, refused, accepted: answers.includes(refused) }).toEqual(
            {
              kind,
              dependencyApplied,
              refused,
              accepted: false,
            },
          );
        }
      }
    }
  });
});

describe('classifying one answer', () => {
  const bet = {
    kind: 'BET' as const,
    acceptable: acceptableAnswers({ kind: 'BET' }),
    primary: 201,
  };

  test('the primary answer of the request is expected', () => {
    expect(classifyAnswer({ ...bet, outcome: 201 })).toBe('expected');
  });

  test('a replay answer to a BET is concurrent, not wrong', () => {
    expect(classifyAnswer({ ...bet, outcome: 200 })).toBe('concurrent');
  });

  test('a 422 to a settlement is incorrect: the planner sends no operation the API must refuse', () => {
    const acceptable = acceptableAnswers({ kind: 'WIN', dependencyApplied: false });
    expect(classifyAnswer({ kind: 'WIN', acceptable, primary: 201, outcome: 422 })).toBe(
      'incorrect',
    );
  });

  test('a 202 to a settlement whose BET was already applied is incorrect: the reference had to be there', () => {
    const acceptable = acceptableAnswers({ kind: 'WIN', dependencyApplied: true });
    expect(classifyAnswer({ kind: 'WIN', acceptable, primary: 201, outcome: 202 })).toBe(
      'incorrect',
    );
  });

  test('a 202 to a settlement whose BET was still in flight is concurrent', () => {
    const acceptable = acceptableAnswers({ kind: 'WIN', dependencyApplied: false });
    expect(classifyAnswer({ kind: 'WIN', acceptable, primary: 201, outcome: 202 })).toBe(
      'concurrent',
    );
  });

  test('a 404 to a read of a BET already applied is incorrect: an acknowledged write must be visible', () => {
    const acceptable = acceptableAnswers({ kind: 'READ_TRANSACTION', dependencyApplied: true });
    expect(
      classifyAnswer({ kind: 'READ_TRANSACTION', acceptable, primary: 200, outcome: 404 }),
    ).toBe('incorrect');
  });

  test('a lost request is lost, not incorrect', () => {
    expect(classifyAnswer({ ...bet, outcome: 'LOST' })).toBe('lost');
  });
});

describe('which requests depend on which BET', () => {
  const bet = { position: 0, wallet: 0, hot: false, round: 'r', externalId: 'bet-1' };

  test('a BET depends on nothing, and a wallet read depends on nothing', () => {
    expect(dependencyOf({ kind: 'BET', position: 0, bet })).toBeUndefined();
    expect(dependencyOf({ kind: 'READ_WALLET', position: 1, wallet: 0 })).toBeUndefined();
  });

  test('a replay, a read and every settlement depend on their BET', () => {
    const operations: PlannedOperation[] = [
      { kind: 'REPLAY', position: 2, bet },
      { kind: 'READ_TRANSACTION', position: 3, bet },
      { kind: 'WIN', position: 4, bet, externalId: 'win-1' },
    ];
    for (const operation of operations) expect(dependencyOf(operation)).toBe('bet-1');
  });

  test('a BET or a replay that was answered 200 or 201 applies its BET; a refusal does not', () => {
    const replay: PlannedOperation = { kind: 'REPLAY', position: 2, bet };
    expect(appliedBy({ kind: 'BET', position: 0, bet }, 201)).toBe('bet-1');
    expect(appliedBy(replay, 200)).toBe('bet-1');
    expect(appliedBy({ kind: 'BET', position: 0, bet }, 422)).toBeUndefined();
    expect(appliedBy({ kind: 'WIN', position: 4, bet, externalId: 'win-1' }, 201)).toBeUndefined();
  });
});

describe('the incorrect answers of a step', () => {
  test('counts each wrong status per kind, and nothing else', () => {
    const samples = [
      {
        kind: 'WIN' as const,
        outcome: 202,
        primary: 201,
        acceptable: acceptableAnswers({ kind: 'WIN', dependencyApplied: true }),
      },
      {
        kind: 'WIN' as const,
        outcome: 202,
        primary: 201,
        acceptable: acceptableAnswers({ kind: 'WIN', dependencyApplied: true }),
      },
      {
        kind: 'READ_TRANSACTION' as const,
        outcome: 404,
        primary: 200,
        acceptable: acceptableAnswers({ kind: 'READ_TRANSACTION', dependencyApplied: true }),
      },
      {
        kind: 'READ_TRANSACTION' as const,
        outcome: 404,
        primary: 200,
        acceptable: acceptableAnswers({ kind: 'READ_TRANSACTION', dependencyApplied: false }),
      },
      {
        kind: 'BET' as const,
        outcome: 201,
        primary: 201,
        acceptable: acceptableAnswers({ kind: 'BET' }),
      },
      {
        kind: 'BET' as const,
        outcome: 'LOST' as const,
        primary: 201,
        acceptable: acceptableAnswers({ kind: 'BET' }),
      },
    ];
    expect(incorrectAnswers(samples)).toEqual([
      { kind: 'WIN', status: 202, count: 2 },
      { kind: 'READ_TRANSACTION', status: 404, count: 1 },
    ]);
  });
});

function facts(overrides: Partial<StepFacts> = {}): StepFacts {
  return {
    lost: 0,
    errorRate: 0,
    p95: 20,
    p99: 40,
    lagP99Ms: 2,
    drainSeconds: 0.5,
    violations: 0,
    duplicates: 0,
    incorrect: [],
    peakRssMiB: { 'api-1': 120 },
    ...overrides,
  };
}

describe('the reasons a step fails', () => {
  test('a step that breaks no constraint has no reason', () => {
    expect(stepReasons(facts())).toEqual([]);
  });

  test('a step whose latency passes still fails when it has an incorrect answer', () => {
    const reasons = stepReasons(facts({ incorrect: [{ kind: 'WIN', status: 202, count: 13 }] }));
    expect(reasons).toEqual(['13 incorrect answers (WIN 202 ×13)']);
  });

  test('every incorrect answer kind and status is named, so the failure can be read from the report', () => {
    const reasons = stepReasons(
      facts({
        incorrect: [
          { kind: 'WIN', status: 202, count: 2 },
          { kind: 'READ_TRANSACTION', status: 404, count: 1 },
        ],
      }),
    );
    expect(reasons).toEqual(['3 incorrect answers (WIN 202 ×2, READ_TRANSACTION 404 ×1)']);
  });

  test('the existing constraints keep their wording', () => {
    expect(stepReasons(facts({ lost: 2 }))).toEqual(['2 requests lost (max 0)']);
    expect(stepReasons(facts({ p99: 1200 }))).toEqual(['p99 1200.0 ms (max 1000)']);
    expect(stepReasons(facts({ drainSeconds: null }))).toEqual([
      `outbox drained in more than ${DRAIN_CAP_SECONDS} s (max 60)`,
    ]);
  });
});
