# Implementation plan and status

> English reference copy. The main version, in Portuguese, is [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

> **Appendix.** The log of the slices, kept as history. Where it differs from [ARCHITECTURE.md](../ARCHITECTURE.en.md),
> ARCHITECTURE.md is the current reading.
>
> The load figures on this page come from an earlier round and are superseded. The current values are in [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md).

The [challenge specification](CHALLENGE.md) is authoritative. The
[requirements matrix](REQUIREMENTS_MATRIX.md) is the detailed status. This page
summarises the slices and what each one proved.

## Foundation and tooling

- [x] Bun 1.4.4 pinned locally, in CI and in the Dockerfile. `bun.lock` committed.
- [x] `check:fast` and `check:all` run what they announce. CI runs `check:all`.
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
- [x] Migration 3: a referenced transaction is reversed once, whatever the kind of reversal, and a
      WIN may carry the reference of its BET. Reversible.
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
- [x] Broker-side redrive after ten deliveries is verified on the Compose-provisioned queue.

## HTTP, health and observability

- [x] Endpoints in `ARCHITECTURE.md` section 10, with the status taxonomy.
- [x] Liveness is dependency-free. Readiness probes PostgreSQL and SQS and answers 503 when either fails.
- [x] JSON operation logs with no amounts. Per-process metrics at `GET /metrics`.
- [x] Each minimum metric has an assertion: transactions, replays, lock conflicts, retries, DLQ, outbox lag, latency and divergences.

## Concurrency and failure proof

- [x] Hot wallet 80/80, fifty identical requests, distinct wallets, a mixed hot wallet, and
      competing reversals, all in process, with the final invariant.
- [x] Three independent API processes and a worker against shared PostgreSQL and LocalStack.
- [x] Crash after commit and before ACK, recovered by a restarted worker, with one effect.
- [x] Graceful SIGTERM exits with 0.
- [x] Fault injection before commit, after broker accept and before mark, and during
      reference resolution.
- [x] Ledger invariant verified at the teardown of every flow-level database suite.
- [x] Process-level crash before commit, and an interrupted batch during shutdown
      (`test/concurrency/process-crash-and-shutdown.test.ts`).

## Documentation and decisions

- [x] `README.md`, `ARCHITECTURE.md` with five Mermaid diagrams, `docs/TEST_STRATEGY.md`.
- [x] Seven ADRs in `docs/adr/`, each with the evidence that supports it. ADR 0006 is superseded by 0007.
- [x] Comparison with public repositories rewritten, then removed from the repository (history in git).
- [x] `CLAUDE.md` for agents.

## Not in this build

- Authentication is not an IdP integration (ADR 0007): API keys with two roles, a hashed key table, provider scope and a CLI to create and revoke keys.
- Load test: pinned to 1, 2 and 4 CPUs on one cloud VM. Agreed rates 25, 100 and 200 req/s; first failing 50, 125 and 300. Records in `docs/load/results/`, report in `docs/LOAD_TEST_RESULTS.md`. It is not in `check:all`.
- Dead-letter replay tooling and a scheduled reconciliation job.

## Finalization review (this branch)

Changes of the review, each with its evidence in the commit message and in `DECISIONS.md` section P:

- Queue and HTTP share one parser for the business fields (`d437452`); a dead-letter copy keeps one copy inside the
  broker's window (`ebc9589`); a duplicate that waits for the lock records no second inbox row (`a10fd11`).
- Phase instrumentation of the transaction, the lock and the outbox (`ceb60c7`), and the load harness reads it
  (`e6b0380`).
- Outbox batches in due order, which fixed an order defect (`89b7bc1`); fewer round trips on the lock path, with an
  outcome query that uses the partial indexes (`9e8dabe`).
- The crash test runs on its own (`f0f1f9b`); test fixtures fail on a missing value (`336110b`).
- Protected mode, an optional Nginx edge with per-client limits, and its suite (`66c590f`).
- The pinned load report of this host: 100, 200 and 400 req/s agreed on 1, 2 and 4 CPUs.
