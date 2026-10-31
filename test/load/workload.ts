/**
 * The product mix of the load test: what a provider sends, in what proportion, and how each
 * operation refers to the ones before it. The planner is pure, so the mix is tested without a server,
 * and each planned operation becomes one HTTP request through `requestFor`.
 *
 * The references follow the rules the API enforces. A settlement (WIN, LOSS), a refund or a rollback
 * names a bet of the same round, and each bet is settled once. A refund or a rollback reverses the
 * stake. The planner never sends an operation the API must refuse, so a 422 in a run means a bug.
 */

export const WORKLOAD_KINDS = [
  'BET',
  'REPLAY',
  'WIN',
  'LOSS',
  'REFUND',
  'ROLLBACK',
  'READ_WALLET',
  'READ_TRANSACTION',
] as const;

export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];
export type Mix = Record<WorkloadKind, number>;

/** The amount of a LOSS. A loss moves no money, so the amount is zero. */
const LOSS_AMOUNT = '0.00';
const CURRENCY = 'BRL';

export interface WorkloadWallet {
  readonly id: string;
  readonly playerId: string;
}

/** A bet as planned. Later operations refer to it, so every reference shares this one object. */
export interface PlannedBet {
  readonly position: number;
  /** Index into the wallets of the run. Wallet 0 is the hot wallet. */
  readonly wallet: number;
  readonly hot: boolean;
  readonly round: string;
  readonly externalId: string;
}

export type SettlementKind = 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export type PlannedOperation =
  | { kind: 'BET'; position: number; bet: PlannedBet }
  /** Re-sends `bet` with its key and body, as a provider does after a timeout. */
  | { kind: 'REPLAY'; position: number; bet: PlannedBet }
  | {
      kind: SettlementKind;
      position: number;
      bet: PlannedBet;
      externalId: string;
    }
  | { kind: 'READ_WALLET'; position: number; wallet: number }
  | { kind: 'READ_TRANSACTION'; position: number; bet: PlannedBet };

export interface PlannerOptions {
  readonly mix: Mix;
  readonly wallets: number;
  /** Share of BETs placed on wallet 0. */
  readonly hotShare: number;
  readonly settleAfter: number;
  readonly readAfter: number;
  readonly replayAfter: number;
  /** Prefix of every external id, so that two runs never reuse an id. */
  readonly runId: string;
  readonly random: () => number;
}

export interface Planner {
  /** The next operations of the run. Positions continue from the previous call. */
  next(count: number): PlannedOperation[];
  /** How many operations of each kind were planned, after the fallbacks. */
  readonly counts: Readonly<Record<WorkloadKind, number>>;
}

/** Items in position order, of which the first `ready` are old enough to refer to. */
class Eligible<T extends { readonly position: number }> {
  private readonly items: T[] = [];
  private ready = 0;

  constructor(private readonly gap: number) {}

  add(item: T): void {
    this.items.push(item);
  }

  advance(position: number): void {
    for (;;) {
      const next = this.items[this.ready];
      if (next === undefined || next.position > position - this.gap) return;
      this.ready += 1;
    }
  }

  pick(random: () => number): T | undefined {
    if (this.ready === 0) return undefined;
    return this.items[Math.floor(random() * this.ready)];
  }

  take(random: () => number): T | undefined {
    if (this.ready === 0) return undefined;
    const index = Math.floor(random() * this.ready);
    const [item] = this.items.splice(index, 1);
    this.ready -= 1;
    return item;
  }
}

export function createPlanner(options: PlannerOptions): Planner {
  const { mix, random } = options;
  const total = WORKLOAD_KINDS.reduce((sum, kind) => sum + mix[kind], 0);
  const reads = new Eligible<PlannedBet>(options.readAfter);
  const replays = new Eligible<PlannedBet>(options.replayAfter);
  /** Bets no settlement, refund or rollback has named yet. */
  const open = new Eligible<PlannedBet>(options.settleAfter);
  const counts = Object.fromEntries(WORKLOAD_KINDS.map((kind) => [kind, 0])) as Record<
    WorkloadKind,
    number
  >;
  let position = 0;

  const drawKind = (): WorkloadKind => {
    const roll = random() * total;
    let upTo = 0;
    for (const kind of WORKLOAD_KINDS) {
      upTo += mix[kind];
      if (roll < upTo) return kind;
    }
    return 'BET';
  };

  const newBet = (at: number): PlannedOperation => {
    const hot = random() < options.hotShare;
    const bet: PlannedBet = {
      position: at,
      wallet: hot ? 0 : Math.floor(random() * options.wallets),
      hot,
      round: `round-${options.runId}-${at}`,
      externalId: `bet-${options.runId}-${at}`,
    };
    reads.add(bet);
    replays.add(bet);
    open.add(bet);
    return { kind: 'BET', position: at, bet };
  };

  const readWallet = (at: number): PlannedOperation => ({
    kind: 'READ_WALLET',
    position: at,
    wallet: Math.floor(random() * options.wallets),
  });

  /** Falls back to the nearest kind that has something to refer to, so that the mix never sends an invalid operation. */
  const build = (drawn: WorkloadKind, at: number): PlannedOperation => {
    switch (drawn) {
      case 'BET':
        return newBet(at);
      case 'REPLAY': {
        const bet = replays.pick(random);
        return bet === undefined ? newBet(at) : { kind: 'REPLAY', position: at, bet };
      }
      case 'WIN':
      case 'LOSS':
      case 'REFUND':
      case 'ROLLBACK': {
        const bet = open.take(random);
        if (bet === undefined) return newBet(at);
        return {
          kind: drawn,
          position: at,
          bet,
          externalId: `${drawn.toLowerCase()}-${options.runId}-${at}`,
        };
      }
      case 'READ_WALLET':
        return readWallet(at);
      case 'READ_TRANSACTION': {
        const bet = reads.pick(random);
        return bet === undefined ? readWallet(at) : { kind: 'READ_TRANSACTION', position: at, bet };
      }
    }
  };

  return {
    next(count: number): PlannedOperation[] {
      const operations: PlannedOperation[] = [];
      for (let index = 0; index < count; index += 1) {
        const at = position;
        position += 1;
        reads.advance(at);
        replays.advance(at);
        open.advance(at);
        const operation = build(drawKind(), at);
        counts[operation.kind] += 1;
        operations.push(operation);
      }
      return operations;
    },
    get counts() {
      return counts;
    },
  };
}

export interface RequestContext {
  readonly providerId: string;
  readonly gameId: string;
  readonly wallets: readonly WorkloadWallet[];
  readonly stake: string;
  readonly winAmount: string;
}

export interface PlannedRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /** Which key the request carries: a provider key for wagering, an operator key for wallets. */
  readonly audience: 'provider' | 'operator';
  readonly body?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
  /** The status the API answers when the request does what it should. Any other answer is reported. */
  readonly expectedStatus: number;
}

function walletAt(context: RequestContext, index: number): WorkloadWallet {
  const wallet = context.wallets[index];
  if (wallet === undefined) throw new Error(`no wallet ${index} in the run`);
  return wallet;
}

function betRequest(bet: PlannedBet, context: RequestContext): PlannedRequest {
  const wallet = walletAt(context, bet.wallet);
  return {
    method: 'POST',
    path: '/wagering/transactions',
    audience: 'provider',
    idempotencyKey: `${context.providerId}:${bet.externalId}`,
    body: {
      providerId: context.providerId,
      externalTransactionId: bet.externalId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: bet.round,
      gameId: context.gameId,
      kind: 'BET',
      money: { amount: context.stake, currency: CURRENCY },
    },
    expectedStatus: 201,
  };
}

/** The request one planned operation becomes. It is pure: the same operation always gives the same request. */
export function requestFor(operation: PlannedOperation, context: RequestContext): PlannedRequest {
  switch (operation.kind) {
    case 'BET':
      return betRequest(operation.bet, context);
    case 'REPLAY':
      return { ...betRequest(operation.bet, context), expectedStatus: 200 };
    case 'READ_WALLET':
      return {
        method: 'GET',
        path: `/wallets/${walletAt(context, operation.wallet).id}`,
        audience: 'operator',
        expectedStatus: 200,
      };
    case 'READ_TRANSACTION':
      return {
        method: 'GET',
        path: `/providers/${context.providerId}/wagering/transactions/${operation.bet.externalId}`,
        audience: 'provider',
        expectedStatus: 200,
      };
    default: {
      const amount =
        operation.kind === 'WIN'
          ? context.winAmount
          : operation.kind === 'LOSS'
            ? LOSS_AMOUNT
            : context.stake;
      const wallet = walletAt(context, operation.bet.wallet);
      return {
        method: 'POST',
        path: '/wagering/transactions',
        audience: 'provider',
        idempotencyKey: `${context.providerId}:${operation.externalId}`,
        body: {
          providerId: context.providerId,
          externalTransactionId: operation.externalId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: operation.bet.round,
          gameId: context.gameId,
          kind: operation.kind,
          money: { amount, currency: CURRENCY },
          referenceExternalTransactionId: operation.bet.externalId,
        },
        expectedStatus: 201,
      };
    }
  }
}
