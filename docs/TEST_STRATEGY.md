# Test strategy

Each guarantee in the [requirements matrix](REQUIREMENTS_MATRIX.md) names the suite that
proves it. A row is `PASSING` only after its suite has run and passed. This document
describes how the suites are organised, what each one may and may not replace, and how
the environment is kept isolated.

## Suites and commands

| Command                    | What it runs                                                                    | Real infrastructure       |
| -------------------------- | ------------------------------------------------------------------------------- | ------------------------- |
| `bun run typecheck`        | `tsc --noEmit` over `src` and `test`                                            | none                      |
| `bun run lint`             | oxlint on `src` and `test`                                                      | none                      |
| `bun run format:check`     | Prettier                                                                        | none                      |
| `bun run test:unit`        | `test/unit`: domain rules, pure logic, log and metric shapes                    | none                      |
| `bun run test:integration` | `test/integration`: schema, persistence, use cases, messaging, faults           | PostgreSQL and LocalStack |
| `bun run test:concurrency` | `test/concurrency`: real parallel connections, three API processes and a worker | PostgreSQL and LocalStack |
| `bun run test:e2e`         | `test/e2e`: the Nest application over HTTP                                      | PostgreSQL and LocalStack |
| `bun run check:fast`       | typecheck, lint, format, unit                                                   | none                      |
| `bun run check:all`        | `check:fast`, then integration, concurrency and e2e                             | all of the above          |

Start the infrastructure with `bun run infra:up`. The suites read `DATABASE_URL` (default
`postgresql://wagering:wagering@localhost:5432/wagering`) and `SQS_ENDPOINT` (default
`http://localhost:4566`).

## What each layer may replace

- **Unit tests** use real domain objects. They do not use the database or the queue.
- **Integration and e2e tests never replace PostgreSQL or SQS with mocks.** A test that
  claims atomicity or concurrency runs against the real server. Where a test needs a
  failure, it wraps a real component (a unit of work, an outbox store, a transport)
  and fails exactly once. Production code carries no fault hook.
- **Concurrency tests** issue their operations at the same time (`Promise.all`), each
  on its own connection. Nothing waits for one operation before starting the next.
- **The process-level suite** starts real processes with `Bun.spawn`. It waits for
  readiness by polling `/health/ready`. It does not sleep as a synchronization method.
  Timing appears only where SQS visibility is the mechanism under test.

## Isolation

- Every database suite gets its own database, created and migrated at the start, and
  dropped at the end, even after a failure (`test/integration/support/test-database.ts`).
- Every SQS suite gets its own private FIFO queues, with a random suffix, so no test
  sees another test's messages (`test/integration/support/sqs-test-queues.ts`).
- Each process of the cluster opens its own pool and clients, and gets its own port.
- Ports and identifiers are random, so suites can run in any order.
- Long-polling is used where a test receives messages. Short polling can miss messages
  that exist. Every test that receives messages acknowledges them, because an in-flight
  FIFO message blocks its group.

## The ledger invariant

Every database suite checks, when it is dropped, that each wallet's balance equals its
ledger sum. A violation fails the suite and names the rows. The schema-constraint suite
opts out, because it writes rows directly to show what the database refuses, and some
of those states break the invariant on purpose.

## Fault injection

| Point                                               | How it is produced                                                                            | Where                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| After commit, before the SQS acknowledgement        | the process exits with code 137 in a test-only entrypoint (`test/support/crashing-worker.ts`) | `test/concurrency/three-processes.test.ts`            |
| Before commit                                       | the unit of work does its work, then throws before committing                                 | `test/integration/faults/fault-injection.test.ts`     |
| After the broker accepted, before marking published | the outbox store rejects the mark once                                                        | same                                                  |
| While resolving a held reference                    | the unit of work throws before commit, once                                                   | same                                                  |
| Broker unavailable                                  | the transport throws                                                                          | `test/integration/messaging/outbox-publisher.test.ts` |
| Lost race on a unique identity                      | two concurrent transactions, one loses and retries                                            | `test/concurrency/hot-wallet.test.ts`                 |
| Graceful shutdown                                   | `SIGTERM` to a worker process, which must exit with 0                                         | `test/concurrency/three-processes.test.ts`            |

Recovery is always checked by reading the persisted state afterwards: balance, ledger,
outbox and queue.

## Mutation evidence

A suite that passes is not enough. For the rules that carry the guarantees, the
author temporarily broke the rule and ran the suite. The commit that introduced each
rule records the mutants and the number of tests that caught them. Examples:

- the money precision context and the 18-digit bound,
- the ledger's arithmetic and reversal-once rules,
- the version guard and the wallet lock,
- the ACK ordering in the consumer, lease ownership in the publisher,
- the failure classification and the status taxonomy,
- the reference miss counter, its limit and its wallet lock.

A mutant that survives is a finding. Two weaknesses in the tests were found: a lease
assertion that proved nothing (found by reading the test), and a two-worker race test that
did not reach its race window (found when a mutant survived). Both were fixed in the tests.

## Environment notes

- The verified Compose stack is built with the sandbox CA, outside the repository.
  See `ARCHITECTURE.md` section 14.
- Some suites are timing-sensitive by design (SQS visibility, lease expiry). Each uses
  an injected clock where it can, and bounded polling where it cannot.
