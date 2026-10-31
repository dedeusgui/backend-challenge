import { describe, expect, test } from 'bun:test';
import { LOAD_THRESHOLDS } from '../../../test/load/thresholds';
import {
  WORKLOAD_KINDS,
  createPlanner,
  requestFor,
  type Mix,
  type PlannedOperation,
  type RequestContext,
  type WorkloadWallet,
} from '../../../test/load/workload';

/** A seeded generator, so that a test of the mix is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const MIX: Mix = {
  BET: 45,
  REPLAY: 5,
  WIN: 20,
  LOSS: 10,
  REFUND: 3,
  ROLLBACK: 2,
  READ_WALLET: 5,
  READ_TRANSACTION: 10,
};

const WALLETS: WorkloadWallet[] = Array.from({ length: 5 }, (_, index) => ({
  id: `wallet-${index}`,
  playerId: `player-${index}`,
}));

const CONTEXT: RequestContext = {
  providerId: 'provider-a',
  gameId: 'fortune-chimp',
  wallets: WALLETS,
  stake: '5.00',
  winAmount: '9.50',
};

function planner(seed = 7) {
  return createPlanner({
    mix: MIX,
    wallets: WALLETS.length,
    hotShare: 0.1,
    settleAfter: 100,
    readAfter: 100,
    replayAfter: 20,
    runId: 'run',
    random: seeded(seed),
  });
}

function plan(count: number, seed = 7): PlannedOperation[] {
  return planner(seed).next(count);
}

/** The first operation of a kind in a long plan. The plan is long enough to contain every kind. */
function firstOf(kind: PlannedOperation['kind']): PlannedOperation {
  const found = plan(5_000).find((operation) => operation.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} in the plan`);
  return found;
}

describe('the configured product mix', () => {
  test('sums to 100 percent and names every kind the planner can send', () => {
    const percentages = Object.values(LOAD_THRESHOLDS.workloadPercent);
    expect(percentages.reduce((sum, value) => sum + value, 0)).toBe(100);
    const named: string[] = [...WORKLOAD_KINDS];
    expect(named.sort()).toEqual(Object.keys(LOAD_THRESHOLDS.workloadPercent).sort());
  });

  test('the realised share of each kind is within one point of its configured share', () => {
    const operations = plan(20_000);
    const counts = new Map<string, number>();
    for (const operation of operations) {
      counts.set(operation.kind, (counts.get(operation.kind) ?? 0) + 1);
    }
    for (const kind of WORKLOAD_KINDS) {
      const share = ((counts.get(kind) ?? 0) / operations.length) * 100;
      expect(Math.abs(share - MIX[kind])).toBeLessThan(1);
    }
  });
});

describe('the planned references', () => {
  test('a settlement, refund or rollback refers to an earlier bet, and each bet is settled once', () => {
    const settled = new Set<string>();
    let settlements = 0;
    for (const operation of plan(20_000)) {
      if (
        operation.kind === 'WIN' ||
        operation.kind === 'LOSS' ||
        operation.kind === 'REFUND' ||
        operation.kind === 'ROLLBACK'
      ) {
        settlements += 1;
        expect(operation.bet.position).toBeLessThanOrEqual(operation.position - 100);
        expect(settled.has(operation.bet.externalId)).toBe(false);
        settled.add(operation.bet.externalId);
      }
    }
    expect(settlements).toBeGreaterThan(1000);
  });

  test('a replay repeats an earlier bet, and a transaction read names a bet read after the delay', () => {
    for (const operation of plan(20_000)) {
      if (operation.kind === 'REPLAY') {
        expect(operation.bet.position).toBeLessThanOrEqual(operation.position - 20);
      }
      if (operation.kind === 'READ_TRANSACTION') {
        expect(operation.bet.position).toBeLessThanOrEqual(operation.position - 100);
      }
    }
  });

  test('ids are unique across calls to next, so that the steps of one run can share a planner', () => {
    const shared = planner(3);
    const first = shared.next(500);
    const second = shared.next(500);
    const ids = [...first, ...second]
      .filter((operation) => operation.kind === 'BET')
      .map((operation) => (operation.kind === 'BET' ? operation.bet.externalId : ''));
    expect(new Set(ids).size).toBe(ids.length);
    expect(second[0]?.position).toBe(500);
  });
});

describe('the requests the planned operations become', () => {
  test('a WIN refers to its bet, in its round, and pays the win amount', () => {
    const win = firstOf('WIN');
    if (win.kind !== 'WIN') throw new Error('expected a WIN');
    const request = requestFor(win, CONTEXT);
    expect(request.body).toMatchObject({
      kind: 'WIN',
      roundId: win.bet.round,
      referenceExternalTransactionId: win.bet.externalId,
      money: { amount: '9.50', currency: 'BRL' },
    });
    expect(request.expectedStatus).toBe(201);
    expect(request.audience).toBe('provider');
  });

  test('a LOSS carries no amount', () => {
    const request = requestFor(firstOf('LOSS'), CONTEXT);
    expect(request.body).toMatchObject({
      kind: 'LOSS',
      money: { amount: '0.00', currency: 'BRL' },
    });
  });

  test('a REFUND and a ROLLBACK reverse exactly the stake of their bet', () => {
    for (const kind of ['REFUND', 'ROLLBACK'] as const) {
      const operation = firstOf(kind);
      if (operation.kind !== 'REFUND' && operation.kind !== 'ROLLBACK') {
        throw new Error(`expected a ${kind}`);
      }
      const request = requestFor(operation, CONTEXT);
      expect(request.body).toMatchObject({
        kind,
        money: { amount: '5.00', currency: 'BRL' },
        referenceExternalTransactionId: operation.bet.externalId,
      });
    }
  });

  test('a replay sends the same key and the same body as the bet it repeats', () => {
    const bet = plan(200).find((operation) => operation.kind === 'BET');
    if (bet === undefined) throw new Error('no BET in the plan');
    const replay: PlannedOperation = { kind: 'REPLAY', position: 999, bet: bet.bet };
    const original = requestFor(bet, CONTEXT);
    const again = requestFor(replay, CONTEXT);
    expect(again.body).toEqual(original.body);
    expect(again.idempotencyKey).toBe(original.idempotencyKey);
    expect(again.expectedStatus).toBe(200);
    expect(original.expectedStatus).toBe(201);
  });

  test('a transaction read names the provider and the transaction it reads', () => {
    const read = firstOf('READ_TRANSACTION');
    if (read.kind !== 'READ_TRANSACTION') throw new Error('expected a READ_TRANSACTION');
    const request = requestFor(read, CONTEXT);
    expect(request).toMatchObject({ method: 'GET', audience: 'provider', expectedStatus: 200 });
    expect(request.path).toBe(`/providers/provider-a/wagering/transactions/${read.bet.externalId}`);
  });
});
