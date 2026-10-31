# Public implementation review

Reviewed on 2026-10-31 by reading the three public repositories (shallow clones
at the default branch), grepping their code, and reading their architecture
documents. The reference suites were **not executed**, so no claim here rests on
their test results. These projects are references for trade-offs. Nothing was
copied from them.

Every observation below cites the file that supports it. Claims that could not be
verified are listed at the end and are not used in any decision.

## 1. AndreLopes30/junglegaming-backend-challenge

- **Locking:** the wallet is read with `LockMode.PESSIMISTIC_WRITE`
  (`src/infrastructure/persistence/repositories/wallet.repository.ts`). The outbox
  claim uses `PESSIMISTIC_PARTIAL_WRITE`, which is `FOR UPDATE SKIP LOCKED`
  (`outbox.repository.ts`).
- **Money:** the domain holds `bigint` minor units (`src/domain/money/money.ts`).
  Persistence stores `numeric` as a string, converted with `replace('.', '')`.
- **Outbox during I/O:** the architecture document states that the outbox keeps a
  row lock and a connection open while it calls SQS (section 15). This design
  trades simplicity for long transactions. We do not adopt it.
- **Entrypoints:** `src/main.ts` and `src/worker.ts` are separate. The document
  states that no entrypoint runs migrations.
- **Reconciliation:** documented as diagnostic only; it never corrects a balance or
  bumps a version. We adopt the same rule.
- **Metrics:** per-process counters, with DLQ and lag read from shared
  infrastructure. Stated as a limitation.
- **Auth:** a no-op guard as the extension point. Same decision as ours.

## 2. paulovitorlr/jungle-gaming-challenge

- **Optimistic versioning:** the pending-reference reprocessor reads
  `wallet.version` and calls `walletRepository.update(wallet, expectedVersion)`
  (`src/modules/wagering/application/use-cases/reprocess-pending-references.use-case.ts`).
  The wallet is not locked pessimistically on that path.
- **Leases:** the outbox publisher takes a lease with a configured duration
  (`src/modules/messaging/infrastructure/outbox/outbox-publisher.service.ts`), and
  claims use `FOR UPDATE SKIP LOCKED`. The send happens outside the claim
  transaction. This is the design we adopt.
- **Mappers:** explicit mapper files exist for each persistence entity
  (`wager-transaction.mapper.ts`, `wallet.mapper.ts`).
- **Money:** `decimal.js` value object (`src/shared/domain/value-objects/money.vo.ts`),
  with `numeric(20, 2)` columns. This matches our choice.

## 3. eriksonwilliam/jungle-gaming-wagering

- **Locking:** `LockMode.PESSIMISTIC_WRITE` on the wallet
  (`src/infrastructure/persistence/mikro-orm/repositories/wallet.repository.ts`),
  and `PESSIMISTIC_PARTIAL_WRITE` on the outbox.
- **Money:** `bigint` minor units in the ledger and wager repositories, through
  `toMinorUnits()` and `BigInt(...)`.
- **Operations:** a Keycloak JWT verifier and guard, a Prometheus metrics adapter,
  and a Grafana dashboard are present. The challenge gives no points for these.
  We do not adopt them, as `docs/REFERENCE_REVIEW.md` previously recommended.

## What this changed in our decisions

- **Wallet lock:** all three use a pessimistic row lock. Our own mutation
  evidence adds one fact they do not establish: without the row lock, the version
  guard still prevents corruption, but a hot wallet exhausts its retries under
  load (`test/concurrency/hot-wallet.test.ts`). The lock is kept for
  availability, not only for correctness. See `docs/adr/0001-pessimistic-wallet-lock.md`.
- **Money representation:** two references use minor units in the domain. We use
  `decimal.js` with `NUMERIC(20,2)`, as the architecture document decided. Minor
  units are a simpler exact representation for two-decimal currencies, and we
  would reconsider the choice if the domain grew beyond that. Recorded in
  `docs/adr/0002-money-representation.md`.
- **Outbox I/O:** we keep the send outside any transaction, following
  `paulovitorlr`. The send-inside-transaction design in `AndreLopes30` is
  rejected: it holds a connection and a row lock for the whole broker call.
- **Reconciliation:** diagnostic only, as in `AndreLopes30`.

## Consultation on testing, and what we might be forgetting

Re-read in this round, against the test suites of the three repositories. The question was whether
the challenge's testing requirements (section 13) and the concurrency scenario (section 8) are fully
covered here, and what the other implementations test that we do not.

| Area                                  | What the reference does                                                                                                                                                                                                                                                                               | What this project does                                                                                                                                                                      | Decision                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Same operation from several processes | andre: `test/integration/multi-process-concurrency.test.ts` (three HTTP processes, state kept across restart). paulo: `test/concurrency/multiprocess-concurrency.spec.ts` (hot wallet across independent processes). erikson: `duplicate-bet.concurrency.test.ts` (fifty parallel BETs, one process). | `test/concurrency/three-processes.test.ts` and `distributed-contention.test.ts`: real processes, one idempotency key with three payloads, competing reversals and results, lost-lock check. | Adopted, and extended beyond the references.                                                            |
| "Multi-instance"                      | paulo's suite says "Three application contexts in one process". erikson's instances run in one process too (no `spawn` in the suite).                                                                                                                                                                 | Real processes only.                                                                                                                                                                        | Our suites are stronger here. Noted so the claim is not repeated as proof.                              |
| Two publishers over one outbox        | erikson: `outbox-publishers.concurrency.test.ts`, in one process against real PostgreSQL.                                                                                                                                                                                                             | In one process, and now across two worker processes with a lost-lease count (`distributed-contention.test.ts`).                                                                             | Adopted across processes.                                                                               |
| Several workers on one wallet         | Not tested by any of the three.                                                                                                                                                                                                                                                                       | `distributed-contention.test.ts`: two workers, forty operations on one wallet, and a worker killed mid-contention.                                                                          | Added here.                                                                                             |
| Load test                             | erikson: `test/load/run.ts`, against nginx and three instances, with Keycloak tokens, p95 by scenario.                                                                                                                                                                                                | `bun run test:load`: three processes and two workers, client-side p50, p95, p99, the outbox lag, and the invariant after the run. Writes `docs/LOAD_TEST_RESULTS.md`.                       | Adopted in our form. It is not in `check:all`.                                                          |
| Dashboards and metrics export         | erikson: Prometheus and Grafana provisioned by Compose, with a scrape config for each instance.                                                                                                                                                                                                       | JSON `GET /metrics` per process, no aggregation.                                                                                                                                            | Not adopted. The challenge does not ask for it. It is the first candidate if observability is reviewed. |
| Identity                              | erikson: Keycloak, the identity provider the challenge suggests.                                                                                                                                                                                                                                      | API keys with two roles (ADR 0007).                                                                                                                                                         | Deliberate deviation. Owner decision D5 in `INVARIANT_REVIEW.md`.                                       |
| Coverage                              | erikson: `test:coverage` script.                                                                                                                                                                                                                                                                      | None.                                                                                                                                                                                       | Candidate. Coverage says nothing about the interleavings that matter here, so it is not a gate.         |
| Mutation testing                      | None of the three.                                                                                                                                                                                                                                                                                    | Manual mutants, recorded in `TEST_STRATEGY.md`, four in this round.                                                                                                                         | No tool added. The manual record is kept honest with the one survivor (`SKIP LOCKED`).                  |
| Smoke test of a running stack         | andre: `infra:check` script (`check-infrastructure.ts`), which checks the stack before tests.                                                                                                                                                                                                         | `/health/ready` only, checked by hand.                                                                                                                                                      | Candidate: a script that posts one BET to a running Compose stack.                                      |
| Unit tests with test doubles          | erikson: `test/unit/application/use-cases/*` with fakes.                                                                                                                                                                                                                                              | Unit tests use real domain objects, and no fakes for the database or the queue.                                                                                                             | Kept. It matches the rule against replacing the database and the queue.                                 |
| Restart and worker entrypoint         | paulo: `restart-recovery.e2e.spec.ts`. andre: `worker-entrypoint.test.ts`.                                                                                                                                                                                                                            | `three-processes.test.ts` (restart, SIGTERM) and `process-crash-and-shutdown.test.ts` (kill before commit, SIGTERM during a batch).                                                         | Covered.                                                                                                |
| Constraints                           | paulo: `database-constraints.e2e.spec.ts`. erikson: `schema-constraints.integration.test.ts`.                                                                                                                                                                                                         | `test/integration/schema/schema-constraints.test.ts`, 38 test declarations, each probe failing before its migration exists.                                                                 | Covered.                                                                                                |

### What we might still be missing

1. **An API process killed inside a transaction.** No reference tests it either. The HTTP path is
   covered in-process, and by a provider's retry under the same key.
2. **A smoke test of the running Compose stack**, the equivalent of andre's `infra:check`.
3. **Coverage numbers**, which the references publish and we do not.
4. **Metrics that a dashboard can read**, as erikson provisions them.
5. **The wait for the wallet lock**, which no reference measures either. This project does not measure
   it. `concurrency_conflicts_total` counts lost races only.

## Not verified, not used

- Test counts and pass or fail status of the reference suites.
- `paulovitorlr`'s "some entities under a catch-all shared area" claim, which
  the previous review made without evidence.
- Any behaviour under concurrency or failure in the reference code. We did not
  run it, so no conclusion about correctness is drawn.
