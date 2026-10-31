/**
 * The constraints and the workload the load test is held to. They are written here, under review,
 * before a run. A step that breaks one of the constraints fails, whatever its throughput. The ramp
 * stops at the first failing step, and the agreed rate is the highest step that passed all of them.
 *
 * Change a number here only in a commit of its own, with the reason in the message.
 */
export const LOAD_THRESHOLDS = {
  /** Requests per second of each step, in order. The ramp stops at the first step that fails. */
  stepRatesPerSecond: [10, 25, 50, 75, 100, 125, 150, 200, 300, 400],
  /** Length of each step. A step proves this many seconds at its rate, and nothing longer. */
  stepSeconds: 20,
  /**
   * Traffic sent before anything is measured, so that the first step does not pay for a cold stack
   * (JIT, connection pools, first queries). Its requests are in the planned counts, not in the steps.
   */
  warmupRatePerSecond: 25,
  warmupSeconds: 20,
  /** Quiet period before the ramp, to measure what the stack uses when nothing is sent. */
  idleSeconds: 10,
  /** A request with no HTTP response within this time is lost. */
  requestTimeoutMs: 10_000,
  /** Lost requests and 5xx answers, as a share of the requests sent in the step. */
  maxErrorRate: 0.001,
  /** Requests that got no HTTP response at all. */
  maxLostRequests: 0,
  /** Latency of every answered request, measured from the scheduled send time. */
  maxP95Ms: 500,
  maxP99Ms: 1000,
  /**
   * The generator must send its requests on time. The p99 of the lag is checked, not the maximum:
   * one garbage-collection pause must not invalidate a step. A step whose generator is late for 1% of
   * its requests measured the generator, not the system.
   */
  maxGeneratorLagP99Ms: 50,
  /** After a step, every committed event must reach the events queue within this time. */
  maxOutboxDrainSeconds: 60,
  /** Resident memory of any one process at its peak during a step. */
  maxRssMiBPerProcess: 512,
  /** Wallets the load runs over. Wallet 0 is the hot wallet. */
  wallets: 50,
  startingBalance: '1000000.00',
  /** Amount of every BET. A REFUND or a ROLLBACK reverses exactly this amount. */
  stake: '5.00',
  /** Amount of every WIN. A LOSS carries no amount. */
  winAmount: '9.50',
  /** Share of BETs placed on the hot wallet. */
  hotShare: 0.1,
  /**
   * A settlement, refund or rollback is sent this many operations after its BET, so the BET has
   * usually committed. The gap is in operations, so it is shorter at a higher rate.
   */
  settleAfterOperations: 100,
  /** A read of a transaction is sent this many operations after the BET it reads. */
  readAfterOperations: 100,
  /** A replay re-sends a BET this many operations after it, with the same key and body. */
  replayAfterOperations: 20,
  /**
   * The product mix, in percent of all operations. It is what a provider sends in a normal hour:
   * mostly bets, then the results of the rounds, a few reversals, and reads of the wallets and of
   * the transactions. Replays are the retries a provider sends when it did not get an answer.
   */
  workloadPercent: {
    BET: 45,
    REPLAY: 5,
    WIN: 20,
    LOSS: 10,
    REFUND: 3,
    ROLLBACK: 2,
    READ_WALLET: 5,
    READ_TRANSACTION: 10,
  },
  apiProcesses: 3,
  workerProcesses: 2,
} as const;
