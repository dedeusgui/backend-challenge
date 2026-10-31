# Test strategy

Each guarantee in the [requirements matrix](REQUIREMENTS_MATRIX.md) names the suite that
proves it. A row is `PASSING` only after its suite has run and passed. This document says how
the suites are organised, what each may and may not replace, which failures they inject, and
what mutation evidence says about whether they can fail.

## Suites and commands

| Command                    | What it runs                                                                                         | Real infrastructure       |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------- |
| `bun run typecheck`        | `tsc --noEmit` over `src` and `test`                                                                 | none                      |
| `bun run lint`             | oxlint on `src` and `test`                                                                           | none                      |
| `bun run format:check`     | Prettier                                                                                             | none                      |
| `bun run test:unit`        | `test/unit`: domain rules, pure logic, log and metric shapes, the auth rules, the worker loops       | none                      |
| `bun run test:integration` | `test/integration`: schema and migrations, persistence, use cases, messaging, faults, the auth table | PostgreSQL and LocalStack |
| `bun run test:concurrency` | `test/concurrency`: parallel connections, three API processes and two workers, crashes, shutdown     | PostgreSQL and LocalStack |
| `bun run test:e2e`         | `test/e2e`: the Nest application over HTTP, with API keys                                            | PostgreSQL and LocalStack |
| `bun run test:load`        | `test/load/load-test.ts`: optional load run; writes `docs/LOAD_TEST_RESULTS.md`                      | PostgreSQL and LocalStack |
| `bun run check:fast`       | typecheck, lint, format, unit                                                                        | none                      |
| `bun run check:all`        | `check:fast`, then integration, concurrency and e2e. This is the gate, and CI runs it                | all of the above          |

`test:load` is not part of `check:all`. It takes minutes, and its numbers describe the machine
it runs on.

Start the infrastructure with `bun run infra:up`. The suites read `DATABASE_URL` (default
`postgresql://wagering:wagering@localhost:5432/wagering`) and `SQS_ENDPOINT` (default
`http://localhost:4566`).

## What the spec asks for, and where each item is proven

The challenge's section 13 lists the required tests. Each one maps to a suite:

| Requirement (section 13)                                 | Proven by                                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrency 1: one BET sent 50 times in parallel         | `test/concurrency/hot-wallet.test.ts` (in one process); `test/concurrency/three-processes.test.ts` (fifty requests over three processes) |
| Concurrency 2: operations competing for one balance (§8) | `test/concurrency/hot-wallet.test.ts`; `test/concurrency/distributed-contention.test.ts`                                                 |
| Concurrency 3: distinct wallets in parallel              | `test/concurrency/hot-wallet.test.ts`; `test/concurrency/three-processes.test.ts`                                                        |
| Concurrency 4: three or more processes at once           | `test/concurrency/three-processes.test.ts`; `test/concurrency/distributed-contention.test.ts`                                            |
| Concurrency 5: worker killed after commit, before ACK    | `test/concurrency/three-processes.test.ts`                                                                                               |
| Concurrency 6: two publishers over one outbox            | `test/concurrency/distributed-contention.test.ts` (processes); `test/integration/messaging/outbox-publisher.test.ts` (in one process)    |
| Concurrency 7: ROLLBACK or REFUND before its reference   | `test/integration/wagering/pending-reference.test.ts`; `test/integration/faults/fault-injection.test.ts`                                 |
| Concurrency 8: restart with final consistency            | `test/concurrency/three-processes.test.ts`; `test/concurrency/process-crash-and-shutdown.test.ts`                                        |
| §8: several workers receive operations of one wallet     | `test/concurrency/distributed-contention.test.ts`                                                                                        |
| Final invariant: `wallet.balance == ledger`              | checked at the teardown of every database suite (see Isolation), and in each concurrency test                                            |

Every item is run against real PostgreSQL and real LocalStack. None is run against a mock.

## What each layer may replace

- **Unit tests** use real domain objects. They do not use the database or the queue.
- **Integration, e2e and concurrency tests never replace PostgreSQL or SQS with mocks.** A test
  that claims atomicity or concurrency runs against the real server. Where a test needs a
  failure, it wraps a real component (a unit of work, an outbox store, a transport) and fails
  exactly once. Production code carries no fault hook.
- **Concurrency tests** issue their operations at the same time (`Promise.all`), each on its own
  connection. Nothing waits for one operation before starting the next.
- **The process-level suites** start real processes with `Bun.spawn` and stop them with signals.
  They wait for readiness by polling `/health/ready`, and for effects by polling the database. A
  sleep is never the synchronisation. Timing appears only where SQS visibility is the mechanism
  under test.
- **Test-only entrypoints** live in `test/support`. Each one wraps a real component to stop the
  process at a chosen point: `crashing-worker.ts` (after commit), `crashing-before-commit-worker.ts`
  (inside a transaction, before commit) and `slow-worker.ts` (a delay per transaction, so a batch is
  in progress when SIGTERM arrives). They use the test-only seams `faults` and `decorateUnitOfWork`
  of `createWorkerRuntime`, which production never passes.

## Isolation

- Every database suite gets its own database, created and migrated at the start, and dropped at
  the end, even after a failure (`test/integration/support/test-database.ts`).
- Every SQS suite gets its own private FIFO queues, with a random suffix, so no test sees another
  test's messages (`test/integration/support/sqs-test-queues.ts`).
- Each process of a cluster opens its own pool and clients, and gets its own port.
- A process-level test stops every worker it started, and a failing test is followed by a kill of
  any worker left behind. Otherwise a leftover worker would consume the queue of the next test.
  That happened once while these suites were written.
- Ports and identifiers are random, so suites can run in any order.
- Long polling is used where a test receives messages. Short polling can miss messages that exist.
  Every test that receives messages acknowledges them, because an in-flight FIFO message blocks its
  group. A test that must not wait behind another test's in-flight message uses its own group.

## The ledger invariant

Every database suite checks, when it is dropped, that each wallet's balance equals its ledger sum.
A violation fails the suite and names the rows. The schema-constraint suite opts out, because it
writes rows directly to show what the database refuses, and some of those states break the
invariant on purpose.

## Fault injection

| Point                                               | How it is produced                                                                                              | Where                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| After commit, before the SQS acknowledgement        | the worker process exits with code 137 in a test-only entrypoint (`test/support/crashing-worker.ts`)            | `test/concurrency/three-processes.test.ts`            |
| Inside a transaction, before commit                 | the worker process exits with code 137 after the writes, before the commit (`crashing-before-commit-worker.ts`) | `test/concurrency/process-crash-and-shutdown.test.ts` |
| A worker killed while another takes the same wallet | `SIGKILL` to one of two workers in the middle of a contention                                                   | `test/concurrency/distributed-contention.test.ts`     |
| Before commit, in one process                       | the unit of work does its work, then throws before committing                                                   | `test/integration/faults/fault-injection.test.ts`     |
| After the broker accepted, before marking published | the outbox store rejects the mark once                                                                          | `test/integration/faults/fault-injection.test.ts`     |
| While resolving a held reference                    | the unit of work throws before commit, once                                                                     | `test/integration/faults/fault-injection.test.ts`     |
| Broker unavailable                                  | the transport throws                                                                                            | `test/integration/messaging/outbox-publisher.test.ts` |
| Lost race on a unique identity                      | two concurrent transactions, one loses and retries                                                              | `test/concurrency/hot-wallet.test.ts`                 |
| Graceful shutdown                                   | `SIGTERM` to a worker process, which must exit with 0                                                           | `test/concurrency/three-processes.test.ts`            |
| SIGTERM during a batch                              | the batch in progress finishes and is acknowledged; nothing is left in flight                                   | `test/concurrency/process-crash-and-shutdown.test.ts` |

Recovery is always checked by reading the persisted state afterwards: balance, ledger, outbox and
queue.

**Not injected:** a crash of the HTTP API process inside a transaction. The API is covered in
process only by the concurrency tests, and by in-process faults. A provider's retry under the same
idempotency key is covered in-process.

## Mutation evidence

A suite that passes is not enough. For the rules that carry the guarantees, the author broke the
rule on purpose and ran the suite. A mutant the suite does not catch is a finding.

Mutants of this round, run against `test/concurrency/distributed-contention.test.ts`:

| Mutant | Rule removed                                                               | Result                                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1     | the wallet row lock (`FOR UPDATE` in `findForUpdate`)                      | **Killed.** The suite still passed, because the version guard and retries keep the final state right. The zero-retry test failed: three lost races. Added to the suite for this reason.                                                      |
| M2     | the reversal guard in `TransactionSettlement` (one reversal per reference) | **Killed**, by the refund-and-rollbacks test and by the zero-retry test.                                                                                                                                                                     |
| M3     | `SKIP LOCKED` in the outbox claim                                          | **Survived.** This mutant is equivalent for safety. The second publisher waits for the first, then re-checks the lease predicate and excludes the row. `SKIP LOCKED` removes the wait, and no test measures a wait. Recorded as a known gap. |
| M4     | the outbox lease predicate (`lease_expires_at IS NULL OR ... < now`)       | **Killed.** The two-publisher test failed: 61 lost leases, which are double claims.                                                                                                                                                          |

Mutants of earlier rounds, each caught by at least one test:

- the money precision context and the 18-digit bound;
- the ledger's arithmetic and reversal-once rules;
- the version guard and the wallet lock (the lock is now also covered by the zero-retry test);
- the ACK ordering in the consumer, and lease ownership in the publisher;
- the failure classification and the status taxonomy;
- the reference miss counter, its limit and its wallet lock;
- the cap of the reference retry delay (`test/unit/wagering/domain/reference-retry-policy.test.ts`).

Two weaknesses in the tests were found and fixed. A lease assertion proved nothing, found by
reading the test. A two-worker race test did not reach its race window, found when a mutant
survived.

## Load

`bun run test:load` runs the stack as processes (three API, two workers, PostgreSQL, LocalStack) and
sends requests on a fixed schedule, in steps of increasing rate. Each step is checked against the
constraints in `test/load/thresholds.ts`: error rate, lost requests, p95 and p99 latency, generator
lag at p99, outbox drain, memory per process, and the invariant `balance == ledger`. The ramp stops at
the first step that fails. The method and its reasons are in `DECISIONS.md`, group N.

The agreed figure on the cloud machine used for this work is **150 requests per second sustained**,
with **200 requests per second** as the observed ceiling. Six runs are in
[LOAD_TEST_HISTORY.md](LOAD_TEST_HISTORY.md). The latest report, with its CPU per component and its
lost requests, is in [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md).

**What these runs prove, and what they do not:**

- They prove the constraints held for the length of one step, at one rate, on this machine.
- They do not prove a longer run. There is no soak test.
- The load generator runs on the same CPUs as the system. A dedicated machine would move the knee.
- The queue is LocalStack, and PostgreSQL has its default configuration, with no replica.
- The mix is ours: BETs over 50 wallets, about 5% on one hot wallet, about 5% replays. Real traffic
  has WIN, LOSS, REFUND and ROLLBACK too.
- Latency is the client view. The percentiles come from our own sample, not from a histogram.
- Each step ran once in each run, with no confidence interval. Six runs are the basis of the figure.
- Memory and CPU need Linux or macOS. On Windows, run it inside WSL.

**What the knee suggests.** At 300 requests per second the latency rises for every wallet, and no run
lost a request at that rate. PostgreSQL reached one full core, and the API processes were at about 43%
each. The likely limit is PostgreSQL under the hot-row lock, with its default pool of 10 connections per
process. This is an inference, because lock and pool waits were not measured.

## Environment notes

- The verified Compose stack is built with the sandbox CA, outside the repository. See
  `ARCHITECTURE.md` section 14.
- Some suites are timing-sensitive by design (SQS visibility, lease expiry). Each uses an injected
  clock where it can, and bounded polling where it cannot.
