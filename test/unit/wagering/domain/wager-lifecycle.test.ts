import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../../../src/shared/domain/domain-error';
import { Money } from '../../../../src/shared/domain/money';
import {
  WagerTransaction,
  type WagerTransactionState,
} from '../../../../src/modules/wagering/domain/wager-transaction';
import {
  canChangeStatus,
  decideAgainstHistory,
  STATUS_TRANSITIONS,
  WAGER_TRANSACTION_STATUSES,
  type ReferenceHistory,
  type WagerTransactionStatus,
} from '../../../../src/modules/wagering/domain/wager-lifecycle';
import {
  WAGER_TRANSACTION_KINDS,
  KIND_RULES,
} from '../../../../src/modules/wagering/domain/wager-transaction-kind';

/**
 * The lifecycle rules, checked against expectations written by hand from the specification (ARCHITECTURE 6.3,
 * 7 and the decisions D1 to D4), not derived from the code they test. Each table below lists what must be
 * allowed; every other pair, or combination, must be refused.
 */

const ALLOWED_STATUS_CHANGES: ReadonlyArray<
  readonly [WagerTransactionStatus, WagerTransactionStatus]
> = [
  ['PENDING', 'PENDING_REFERENCE'],
  ['PENDING', 'PROCESSED'],
  ['PENDING', 'REJECTED'],
  ['PENDING', 'FAILED'],
  ['PENDING_REFERENCE', 'PENDING_REFERENCE'],
  ['PENDING_REFERENCE', 'PROCESSED'],
  ['PENDING_REFERENCE', 'REJECTED'],
  ['PENDING_REFERENCE', 'FAILED'],
];

describe('the status table', () => {
  test('lists every status of the enum, and only those', () => {
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual([...WAGER_TRANSACTION_STATUSES].sort());
  });

  test('allows exactly the eight changes written in the specification, and refuses the other seventeen pairs', () => {
    for (const from of WAGER_TRANSACTION_STATUSES) {
      for (const to of WAGER_TRANSACTION_STATUSES) {
        const expected = ALLOWED_STATUS_CHANGES.some(([a, b]) => a === from && b === to);
        expect({ from, to, allowed: canChangeStatus(from, to) }).toEqual({
          from,
          to,
          allowed: expected,
        });
      }
    }
  });

  test('the three terminal statuses have no change to make', () => {
    for (const status of ['PROCESSED', 'REJECTED', 'FAILED'] as const) {
      expect(STATUS_TRANSITIONS[status]).toEqual([]);
    }
  });
});

const CREATED_AT = new Date('2026-07-29T15:00:00.000Z');
const MONEY = Money.from({ amount: '25.00', currency: 'BRL' });

/** A persisted transaction in the given status. Rehydration does not revalidate, which is the point here. */
function inStatus(
  status: WagerTransactionStatus,
  kind: WagerTransactionState['kind'] = 'BET',
): WagerTransaction {
  const holds = status === 'PENDING_REFERENCE';
  const decided = status === 'PROCESSED' || status === 'REJECTED' || status === 'FAILED';
  return WagerTransaction.rehydrate({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-1',
    idempotencyKey: 'provider-a:transaction-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: MONEY,
    referenceExternalTransactionId: kind === 'BET' ? undefined : 'transaction-0',
    createdAt: CREATED_AT,
    status,
    referenceTransactionId: undefined,
    failureCode: status === 'REJECTED' || status === 'FAILED' ? 'INSUFFICIENT_BALANCE' : undefined,
    resultingBalance: status === 'PENDING' ? undefined : MONEY,
    processedAt: status === 'PROCESSED' ? CREATED_AT : undefined,
    referenceAttempts: 0,
    referenceNextAttemptAt: holds || decided ? CREATED_AT : undefined,
  });
}

function refused(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof DomainError ? error.code : `UNEXPECTED ${String(error)}`;
  }
}

describe('each entity method against every starting status', () => {
  const methods: Array<{
    name: string;
    from: readonly WagerTransactionStatus[];
    run: (transaction: WagerTransaction) => void;
  }> = [
    {
      name: 'markPendingReference',
      from: ['PENDING'],
      run: (t) => t.markPendingReference(CREATED_AT, MONEY),
    },
    {
      name: 'recordReferenceMiss',
      from: ['PENDING_REFERENCE'],
      run: (t) => t.recordReferenceMiss(CREATED_AT),
    },
    {
      name: 'markProcessed',
      from: ['PENDING', 'PENDING_REFERENCE'],
      run: (t) =>
        t.markProcessed({
          referenceTransactionId: undefined,
          resultingBalance: MONEY,
          at: CREATED_AT,
        }),
    },
    {
      name: 'reject',
      from: ['PENDING', 'PENDING_REFERENCE'],
      run: (t) => t.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: MONEY }),
    },
    {
      name: 'fail',
      from: ['PENDING', 'PENDING_REFERENCE'],
      run: (t) => t.fail({ code: 'INSUFFICIENT_BALANCE', observedBalance: MONEY }),
    },
  ];

  for (const method of methods) {
    for (const status of WAGER_TRANSACTION_STATUSES) {
      test(`${method.name} from ${status} is ${method.from.includes(status) ? 'allowed' : 'refused with INVALID_TRANSACTION_TRANSITION'}`, () => {
        const outcome = refused(() => method.run(inStatus(status)));
        if (method.from.includes(status)) {
          expect(outcome).toBeUndefined();
        } else {
          expect(outcome).toBe('INVALID_TRANSACTION_TRANSITION');
        }
      });
    }
  }
});

/** The history of a referenced transaction, written as the three facts the rule reads. */
const NO_RESULT: ReferenceHistory = { settled: false, reversed: false };
const SETTLED: ReferenceHistory = { settled: true, reversed: false };
const REVERSED: ReferenceHistory = { settled: false, reversed: true };
const SETTLED_AND_REVERSED: ReferenceHistory = { settled: true, reversed: true };

describe('the decision against a reference history, for every kind that names a reference', () => {
  const expected: Record<'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK', Record<string, string>> = {
    WIN: {
      none: 'ACCEPT',
      settled: 'REFERENCE_ALREADY_SETTLED',
      reversed: 'REFERENCE_ALREADY_REVERSED',
      both: 'REFERENCE_ALREADY_REVERSED',
    },
    LOSS: {
      none: 'ACCEPT',
      settled: 'REFERENCE_ALREADY_SETTLED',
      reversed: 'REFERENCE_ALREADY_REVERSED',
      both: 'REFERENCE_ALREADY_REVERSED',
    },
    REFUND: {
      none: 'ACCEPT',
      settled: 'REFERENCE_ALREADY_SETTLED',
      reversed: 'REFERENCE_ALREADY_REVERSED',
      both: 'REFERENCE_ALREADY_REVERSED',
    },
    ROLLBACK: {
      none: 'ACCEPT',
      settled: 'ACCEPT',
      reversed: 'REFERENCE_ALREADY_REVERSED',
      both: 'REFERENCE_ALREADY_REVERSED',
    },
  };
  const histories: Record<string, ReferenceHistory> = {
    none: NO_RESULT,
    settled: SETTLED,
    reversed: REVERSED,
    both: SETTLED_AND_REVERSED,
  };

  for (const kind of ['WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const) {
    for (const [name, history] of Object.entries(histories)) {
      test(`${kind} against a reference with ${name} result is ${expected[kind][name]}`, () => {
        const decision = decideAgainstHistory(kind, history);
        expect(decision.outcome === 'ACCEPT' ? 'ACCEPT' : decision.code).toBe(
          expected[kind][name] ?? '',
        );
      });
    }
  }

  test('the examples of the owner: a refund after a rollback is refused, and so is a rollback of a refund', () => {
    // A ROLLBACK reversed the BET; a later REFUND of the same BET finds the reversal.
    expect(decideAgainstHistory('REFUND', REVERSED)).toEqual({
      outcome: 'REJECT',
      code: 'REFERENCE_ALREADY_REVERSED',
    });
    // A REFUND reversed the BET; a ROLLBACK of that BET is refused: the reversal is not undone by undoing the refund (D4).
    expect(decideAgainstHistory('ROLLBACK', REVERSED)).toEqual({
      outcome: 'REJECT',
      code: 'REFERENCE_ALREADY_REVERSED',
    });
  });

  test('a ROLLBACK applies to a BET that has a WIN, and the WIN is kept (D2)', () => {
    expect(decideAgainstHistory('ROLLBACK', SETTLED)).toEqual({ outcome: 'ACCEPT' });
  });

  test('BET and OPENING name no reference, so no history rule applies to them', () => {
    for (const kind of ['BET', 'OPENING'] as const) {
      expect(KIND_RULES[kind].reference).toBeUndefined();
    }
  });

  test('every kind of the enum is covered by the table above or by the no-reference rule', () => {
    const covered = new Set<string>(['WIN', 'LOSS', 'REFUND', 'ROLLBACK', 'BET', 'OPENING']);
    expect([...covered].sort()).toEqual([...WAGER_TRANSACTION_KINDS].sort());
  });
});
