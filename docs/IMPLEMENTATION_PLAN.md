# Implementation plan and status

The [challenge specification](CHALLENGE.md) is authoritative. The
[requirements matrix](REQUIREMENTS_MATRIX.md) is the detailed status. This page
summarises the slices and what each one proved.

## Foundation and tooling

- [x] Bun 1.4.4 pinned locally, in CI and in the Dockerfile. `bun.lock` committed.
- [x] `check:fast` and `check:all` run what they announce. CI runs `check:fast`.
- [x] Compose starts PostgreSQL 17 and LocalStack 4.14, provisions the FIFO queues and the
      redrive policy, runs the migration once, then starts the API and the worker.
- [x] Audit findings fixed: the Dockerfile installed without a lockfile, CI used a floating
      Bun version, and `format:check` failed on five files.

## Domain

- [x] `Money`: exact decimal arithmetic, strict input, currency checks, mutation-checked.
- [x] `Wallet` and `WalletLedgerEntry`: balance guard, validate-before-mutate, opening, version.
- [x] `WagerTransaction`: kind rules table, status machine, reference evaluation, failure codes.
- [x] Canonical payload hash with a golden test.
- [x] Integration event envelope and the four concrete events.
- [x] Inbox and outbox entities, with retry backoff.

## Persistence

- [x] Migration 1: tables, constraints, partial indexes, append-only trigger.
- [x] Migration 2: reference schedule, reversible.
- [x] Repositories with explicit mapping and checked parsing of stored enums.
- [x] Migrations applied from empty, rolled back to zero, and re-applied.

## Application

- [x] `ProcessWagerTransaction`: one path for HTTP and SQS, with idempotency under the wallet lock.
- [x] `TransactionSettlement`: the one financial decision, shared with the reference worker.
- [x] `ProcessPendingReferences`: due holds resolved under the wallet lock, bounded retries.
- [x] `OpenWallet`, wallet and transaction queries, reconciliation (diagnostic only).

## Messaging

- [x] Command consumer: ACK after commit, permanent to the DLQ, transient with backoff.
- [x] Outbox publisher: claim and lease with `SKIP LOCKED`, lease-owned marks, at-least-once.
- [ ] Broker-side redrive after five deliveries is configured but not exercised by a test.

## HTTP, health and observability

- [x] Endpoints in `ARCHITECTURE.md` section 10, with the status taxonomy.
- [x] Liveness is dependency-free. Readiness probes PostgreSQL and SQS and answers 503 when either fails.
- [x] JSON operation logs with no amounts. Per-process metrics at `GET /metrics`.
- [ ] Only two counters are asserted end to end. The others are exposed but not yet tested.

## Concurrency and failure proof

- [x] Hot wallet 80/80, fifty identical requests, distinct wallets, a mixed hot wallet, and
      competing reversals, all in process, with the final invariant.
- [x] Three independent API processes and a worker against shared PostgreSQL and LocalStack.
- [x] Crash after commit and before ACK, recovered by a restarted worker, with one effect.
- [x] Graceful SIGTERM exits with 0.
- [x] Fault injection before commit, after broker accept and before mark, and during
      reference resolution.
- [x] Ledger invariant verified at the teardown of every flow-level database suite.
- [ ] Process-level crash before commit, and an interrupted batch during shutdown.

## Documentation and decisions

- [x] `README.md`, `ARCHITECTURE.md` with five Mermaid diagrams, `docs/TEST_STRATEGY.md`.
- [x] Six ADRs in `docs/adr/`, each with the evidence that supports it.
- [x] `docs/REFERENCE_REVIEW.md` rewritten from the three public repositories, with file citations.
- [x] `CLAUDE.md` for agents.

## Not in this build

- Authentication (ADR 0006): deferred and documented, with the extension point in place.
- Load test. Not run. The concurrency suites prove correctness, not throughput.
- Dead-letter replay tooling and a scheduled reconciliation job.
