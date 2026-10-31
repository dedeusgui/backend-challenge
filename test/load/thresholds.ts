/**
 * The constraints the load test is held to. They are written here, under review, before a run.
 * A step that breaks one of them fails, whatever its throughput. The ramp stops at the first
 * failing step, and the agreed rate is the highest step that passed all of them.
 *
 * Change a number here only in a commit of its own, with the reason in the message.
 */
export const LOAD_THRESHOLDS = {
  /** Requests per second of each step, in order. */
  stepRatesPerSecond: [25, 50, 100, 150, 200, 300, 400],
  /** Length of each step. A step proves this many seconds at its rate, and nothing longer. */
  stepSeconds: 20,
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
  /** Wallets the load runs over. One of them is the hot wallet. */
  wallets: 50,
  startingBalance: '1000000.00',
  stake: '5.00',
  /** Share of operations aimed at the hot wallet. */
  hotShare: 0.05,
  /** Share of operations that re-send an earlier request with its original key. */
  replayShare: 0.05,
  apiProcesses: 3,
  workerProcesses: 2,
} as const;
