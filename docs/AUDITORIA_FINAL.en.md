# Final audit

> Reference copy in English. The primary document is [AUDITORIA_FINAL.md](AUDITORIA_FINAL.md).

Final audit record for the submission: audited code, verification methods, status of each quality bar item, findings status, decisions awaiting confirmation from the challenge owner, known gaps not covered by tests, and simulated reviews.

Raw execution data is not versioned in the repository.

## 1. Audited code

- **Commit:** `c151cd7`
- **Command used:** `git log -1 --format=%h -- src test`
- **Date:** 2026-11-01 (18:07:27 -0300)

Commits following this hash modified documentation and catalog files only.

## 2. How it was verified

| Verification                 | Command                                                                | Result                                                                                                                                                                                                                                        |
| :--------------------------- | :--------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation gate              | `bun run check:all`                                                    | Recorded in `docs/gate/ultimo-gate.json` (2026-11-01T20:40:46.191Z, exitCode 0). 937 tests without failures: 490 unit, 4 infrastructure, 247 integration, 23 concurrency, 100 e2e, and 73 Gherkin scenarios (365 steps).                      |
| Static and unit verification | `bun run check:fast`                                                   | Passed 512 unit tests (0 failures), `tsc --noEmit` without errors, `oxlint` without warnings across 256 files, and `prettier --check` passed.                                                                                                 |
| Load and capacity            | `bun run test:load`                                                    | Benchmarks recorded in [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md) (cloud measurement across 1, 2, and 4 CPUs at 100, 200, and 400 req/s) and in [LOAD_TEST_BASELINE.en.md](LOAD_TEST_BASELINE.en.md) (local measurement with 13 scenarios). |
| Financial demonstration      | `bun run demo:finance`                                                 | ExitCode 0 against the container stack: validates BET, WIN, REFUND, ROLLBACK, replay, and reconciliation.                                                                                                                                     |
| HTTP API contract            | `bun test test/unit/openapi/` and `test/e2e/openapi-responses.test.ts` | Routes, schemas, and live responses validated against `docs/openapi.json`.                                                                                                                                                                    |
| Static showcase              | `bun test test/unit/site/static-showcase.test.ts`                      | Static generation validated, published, and returning HTTP 200 via GitHub Pages.                                                                                                                                                              |

## 3. Status of each quality bar item (docs/CHALLENGE.md §14)

Estimates cited from the simulated review bar recorded in [REVISAO_SIMULADA.md](audit/REVISAO_SIMULADA.md).

### 3.1 Financial correctness

- **Bar score:** 20 points in specification (§14). Estimated target in simulated review: 19 points.
- **Evidence:** `src/shared/domain/money.ts` and `test/unit/shared/domain/money.test.ts` (`Money` value object with exact decimal precision, no `number` type); `src/shared/infrastructure/database/migrations/Migration20261101000012.ts` (`wallets_ledger_balance_check` and `wallet_ledger_entries_balance_check` triggers that reject any divergence between balance and ledger at `COMMIT`); `test/integration/persistence/wallet-persistence.test.ts` and `test/integration/schema/schema-constraints.test.ts` (append-only ledger, rejects `UPDATE`, `DELETE`, and `TRUNCATE`); `test/e2e/queries-http.test.ts` (reconciliation between wallet balance and ledger entries sum); `test/concurrency/hot-wallet.test.ts` and `test/unit/wagering/domain/wager-lifecycle.test.ts` (single reversal per reference, no duplicate credit).
- **Known gap:** Open decisions D1 and D2. Under the specification (§6.3), WIN and LOSS may omit the reference to BET, preventing association with the bet or rejection of subsequent results. A ROLLBACK of a BET returns the wager while leaving a previously credited WIN intact. Absence of property-based testing using `fast-check`.

### 3.2 Concurrency

- **Bar score:** 20 points in specification (§14). Estimated target in simulated review: 19 points.
- **Evidence:** `test/concurrency/hot-wallet.test.ts` (50 identical concurrent requests against a single wallet under pessimistic `SELECT FOR UPDATE` locks, exact final balance without negative balance); `test/concurrency/three-processes.test.ts` (50 identical concurrent requests distributed across 3 independent worker processes apply debit exactly once); `test/concurrency/distributed-contention.test.ts` (two concurrent workers with `SIGKILL` injected into one); `test/integration/persistence/wallet-persistence.test.ts` (rejects persistence when expected version is stale).
- **Known gap:** Mutant M3 survived in `test/concurrency/distributed-contention.test.ts` (`SKIP LOCKED` in outbox claim is functionally equivalent for safety, but no test measures lock wait time). Abrupt crash (`SIGKILL`) of an HTTP API process during an active transaction is not tested at the operating system process level.

### 3.3 Idempotency

- **Bar score:** 15 points in specification (§14). Estimated target in simulated review: 14 points.
- **Evidence:** Unique database constraint `UNIQUE (provider_id, idempotency_key)`; `test/integration/wagering/process-wager-transaction.test.ts` (repeated request replays original result and observed balance); `test/integration/messaging/http-and-queue-replay.test.ts` (same command via HTTP and SQS, in either order, applies exactly once); `test/integration/messaging/inbox-message-identity.test.ts` (`wagerMessageFingerprint` rejects conflicting payload with `MESSAGE_PAYLOAD_CONFLICT`).
- **Known gap:** Legacy messages stored before fingerprinting retain only the business payload hash, allowing reuse of the same message with an altered idempotency key (window limited to legacy rows, F-02).

### 3.4 Messaging and failures

- **Bar score:** 15 points in specification (§14). Estimated target in simulated review: 14 points.
- **Evidence:** Transactional outbox written in the same database transaction (`test/integration/messaging/wager-command-consumer.test.ts`); outbox lease and rescheduling decided by database `now()` (`test/integration/messaging/outbox-lease-clock.test.ts` and `test/integration/messaging/outbox-retry-clock.test.ts`); envelope structural constraint on outbox table (`test/integration/messaging/outbox-malformed-row.test.ts`, F-01); visibility extension during batches and slow processing (`test/integration/messaging/visibility-during-batch.test.ts` and `test/integration/messaging/slow-message-hold.test.ts`, F-04 and F-14); crash recovery and graceful shutdown via `SIGTERM` (`test/concurrency/process-crash-and-shutdown.test.ts` and `test/concurrency/three-processes.test.ts`); error classification for DLQ versus retry in `test/unit/wagering/domain/events-and-classification.test.ts`.
- **Known gap:** Visibility renewals have a configured cap of 300 s (`holdLimitSeconds`). Commands exceeding this duration may be re-delivered to another consumer (financial correctness remains protected by idempotency). Network overhead of additional visibility extension calls to SQS was not measured.

### 3.5 Modeling and architecture

- **Bar score:** 10 points in specification (§14). Estimated target in simulated review: 9 points.
- **Evidence:** Inbound and outbound flow mapping in `ARCHITECTURE.md` §1; decoupled ports in `src/wagering/application/ports/` and `src/shared/application/ports/`; clean separation in `messaging/application/inbound/` and `messaging/application/outbound/`; financial invariants encapsulated inside domain entities and `src/wagering/domain/transaction-settlement.ts`; architecture boundaries test in `test/unit/architecture/domain-boundaries.test.ts` (domain free of framework or cloud SDK imports).
- **Known gap:** Contract decisions F-03 (returning 404 for transactions belonging to other providers) and F-13 (persisting `FAILED` and emitting `WagerTransactionFailed`) pending confirmation by challenge owner.

### 3.6 Tests

- **Bar score:** 10 points in specification (§14). Estimated target in simulated review: 9 points.
- **Evidence:** 937 tests without PostgreSQL or LocalStack mocks across integration, concurrency, and e2e suites (`docs/gate/ultimo-gate.json`); 73 executable Gherkin scenarios with 365 steps (`test/features/`); fault injection with OS process termination via `SIGKILL` and `SIGTERM` (`test/concurrency/three-processes.test.ts` and `test/concurrency/process-crash-and-shutdown.test.ts`).
- **Known gap:** Two scenarios tagged `@bloqueado` in `test/features/mensageria.feature` do not run in the feature gate; 22 IDs from `docs/audit/EDGE_CASE_MATRIX.md` lack the `@edge:` tag in feature files; no test covers ROLLBACK arriving before BET and applied successfully after BET arrives (§13.7); no continuous mutation testing integrated in CI.

### 3.7 Observability

- **Bar score:** 5 points in specification (§14). Estimated target in simulated review: 5 points.
- **Evidence:** Structured JSON logs without payload data or monetary figures (`src/shared/observability/structured-log.ts`); `/metrics` route in Prometheus text format (`src/metrics/metrics.controller.ts`) exporting all counters required by §12: `transactions_total`, `idempotent_replays_total`, `commands_total`, `retries_total`, `concurrency_conflicts_total`, `wallet_lock_wait_ms`, `outbox_lag_seconds`, and `processing_latency_ms`; tests in `test/e2e/metrics-prometheus.test.ts` and `test/unit/metrics/metrics-collector.test.ts`; independent `/health/liveness` and `/health/readiness` probes (`test/e2e/readiness.test.ts`).
- **Known gap:** Metrics are emitted per-process without central aggregation. Prometheus and Grafana dashboards were excluded from Compose by scope decision.

### 3.8 Documentation

- **Bar score:** 5 points in specification (§14). Estimated target in simulated review: 5 points.
- **Evidence:** `README.md` with setup instructions, decisions, commands, and repository map; English pair `README.en.md`; `ARCHITECTURE.md` and `ARCHITECTURE.en.md` detailing architecture, concurrency, idempotency, and limitations; consolidated decisions in `DECISIONS.md` and `DECISIONS.en.md`; ADR records in `docs/adr/`; conventions in `docs/CONVENCOES_DOCUMENTACAO.en.md`; OpenAPI contract served at `/openapi.json` and Swagger UI documentation at `/docs`.
- **Known gap:** [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md) is generated in English only by the `test/load/report.ts` script.

## 4. Findings

Source: [FINDINGS.md](audit/FINDINGS.md). Total of 15 evaluated findings: 11 closed in code and 4 open.

### 4.1 Findings closed in code (11)

| ID   | Description                                                             | Code status | Evidence of closure                                                                                                                                                                                            |
| :--- | :---------------------------------------------------------------------- | :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | Malformed outbox envelope halted batch publication                      | Closed      | Commit `2905535` (migration 9 with `CHECK outbox_envelope_shape` constraint). Test: `test/integration/messaging/outbox-malformed-row.test.ts`.                                                                 |
| F-02 | Same `messageId` with distinct `idempotencyKey` accepted as duplicate   | Closed      | Commit `2ec4d5e` (included key in `wagerMessageFingerprint`). Test: `test/integration/messaging/inbox-message-identity.test.ts`.                                                                               |
| F-03 | 403 response for another provider's transaction revealed existence      | Closed      | Commit `154b52a` (uniform 404 response). Test: `test/e2e/authorization-adversarial.test.ts`. Contract decision pending challenge owner confirmation.                                                           |
| F-04 | Slow batch left in-flight messages visible to other consumers           | Closed      | Commit `b398e22` (`ChangeMessageVisibilityBatch` before each message). Test: `test/integration/messaging/visibility-during-batch.test.ts`.                                                                     |
| F-05 | Test fault hooks inside production code                                 | Closed      | Commit `489df8b` (extracted to `assembleWorker` and seams in `test/support/worker-seams.ts`). Suites pass without modified assertions.                                                                         |
| F-06 | Balance-ledger agreement was not enforced by database schema            | Closed      | Migration 12 in commit `c5ddca9` (`wallets_ledger_balance_check` and `wallet_ledger_entries_balance_check` triggers). Test: `test/integration/schema/ledger-agreement-trigger.test.ts`.                        |
| F-07 | Outbox lease compared expiration against caller's local clock           | Closed      | Commits `433ebe2` and `c952ba2` (ownership and rescheduling via database `now()`). Tests: `test/integration/messaging/outbox-lease-clock.test.ts` and `test/integration/messaging/outbox-retry-clock.test.ts`. |
| F-08 | Ledger summary during reconciliation read outside transaction           | Closed      | Commit `0f4fa19` (read via `em.execute` inside transaction under lock). Test: `test/integration/schema/wallet-ledger-summary.test.ts`.                                                                         |
| F-13 | Transaction with permanent failure stalled worker; `FAILED` lacked path | Closed      | Commit `c8ffbcc` (recorded `FAILED` with `WagerTransactionFailed` event). Test: `test/integration/wagering/held-failure.test.ts`. Contract decision pending challenge owner confirmation.                      |
| F-14 | Message exceeding visibility window was redelivered during processing   | Closed      | Commit `6b3b23e` (renewed at each third of visibility window up to 300 s). Tests: `test/integration/messaging/slow-message-hold.test.ts` and `test/unit/messaging/application/wager-command-hold.test.ts`.     |
| F-15 | Worker decided reference deadline using its local clock                 | Closed      | Commit `fc3862c` (`DatabaseClock` reading database `now()` within transaction). Test: `test/integration/wagering/database-clock-references.test.ts`.                                                           |

Confirmation of closure for F-06 is found in migration 12 history (`git log --oneline -- src/shared/infrastructure/database/migrations/Migration20261101000012.ts`): commit `c5ddca9`.

### 4.2 Open findings (4)

| ID   | Description                                                   | Status | Details                                                                                                                                                                                    |
| :--- | :------------------------------------------------------------ | :----- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-09 | Ledger query plan depends on PostgreSQL planner statistics    | Open   | Requires monitoring with `EXPLAIN` in production. Measured queries: sequential scan at 1,000 entries (0.68 ms), index scan at 100,000 (0.44 ms) and 1,000,000 (0.50 ms).                   |
| F-10 | `ROLLBACK` of BET after `ROLLBACK` of REFUND is rejected      | Open   | Contract decision (D4) pending challenge owner confirmation. Code enforces rejection with `REFERENCE_ALREADY_REVERSED`, fixed in tests.                                                    |
| F-11 | Results without reference cannot be bounded to one per BET    | Open   | Contract decision (D1) inherent to specification (§6.3, §7). Documented in `ARCHITECTURE.md` §13 and [INVARIANT_REVIEW.en.md](INVARIANT_REVIEW.en.md).                                     |
| F-12 | Repository Docker image does not build in sandbox environment | Open   | Sandbox TLS proxy emits self-signed certificate (`SELF_SIGNED_CERT_IN_CHAIN`) during `bun install`. Bypassed in sandbox using an external test image; build verified in GitHub Actions CI. |

## 5. Challenge owner decisions that remain open

Eight decisions remain open awaiting confirmation by the challenge owner. The implementation follows the documented choice in each case.

- **F-03 (HTTP status for transaction of another provider):** In `GET /wagering/transactions/:id`, a transaction belonging to another provider returns `404 TRANSACTION_NOT_FOUND`, identical to a non-existent identifier, to avoid enumeration of external transactions. Pending challenge owner decision: confirm uniform 404 or revert to 403.
- **F-10 (ROLLBACK of BET after ROLLBACK of REFUND):** When a REFUND is reversed by ROLLBACK, a subsequent ROLLBACK of the BET is rejected with `REFERENCE_ALREADY_REVERSED`. Pending challenge owner decision: confirm whether a reference admits at most one reversal in total (preventing double credit of stake) or admits net reversals.
- **F-13 (Execution path for FAILED and new domain event):** A held transaction that encounters an unrecoverable failure is recorded as `FAILED` and publishes `WagerTransactionFailed` (event not listed in specification §6.3). Pending challenge owner decision: confirm persisting `FAILED` and introducing this event.
- **D1 (Results without reference):** The specification (§6.3 and §7) allows WIN and LOSS to omit the reference to the bet. Without a reference, the system cannot link the result to the BET or block a subsequent REFUND or second result. Pending challenge owner decision: accept the economic risk of unlinked results or make the reference to BET mandatory for all results.
- **D2 (ROLLBACK in any state of the bet):** A ROLLBACK is accepted against any state of the source transaction, including after a processed WIN, returning the stake while the win credit remains. Pending challenge owner decision: confirm whether cancelling the bet may leave winnings intact or whether ROLLBACK of a BET with a win must be rejected until the WIN is reversed first.
- **D3 (REFUND only for BET without result):** A REFUND is accepted only if the bet has no processed outcome (WIN or LOSS). If a result exists, it is rejected with `REFERENCE_ALREADY_SETTLED`. Pending challenge owner decision: confirm requiring providers to reverse outcomes before requesting refunds.
- **D4 (At most one reversal per reference):** The system limits any reference to at most one reversal, whether REFUND or ROLLBACK. Rule 4 of the specification ("cannot be reversed twice by the same operation type"), read literally, would allow a REFUND followed by a ROLLBACK on the same bet, crediting the stake twice. Pending challenge owner decision: confirm strict constraint against duplicate credit.
- **D5 (Static API key authentication):** Authentication implemented using static API keys with provider scope and roles (`operator` and `provider`), as described in ADR 0007, rather than an external identity provider (IdP) mentioned in specification (§2). Pending challenge owner decision: confirm this authentication simplification adopted for the challenge scope.

## 6. Gaps not covered by tests

Technical limitations of the test suites and measurements:

- **§13.7 (ROLLBACK before reference):** An automated test exists for REFUND arriving before BET in `test/integration/wagering/pending-reference.test.ts`. For ROLLBACK arriving before BET and settling successfully after the bet arrives, no test exists in the repository. The test in `test/integration/wagering/database-clock-references.test.ts` (lines 158 to 191) covers only retention and rejection upon exhaustion of attempts.
- **Gherkin scenarios tagged `@bloqueado`:** The command `grep -c "@bloqueado" test/features/*.feature` reports 2 scenarios in `test/features/mensageria.feature`:
  1. Line 71: "Uma mensagem que falha em dez entregas vai para a DLQ pelo redrive" (`@edge:QU-04`). Reason: the isolated BDD harness does not receive SQS redrive policy; real coverage is proven in `test/integration/messaging/broker-redrive.test.ts`.
  2. Line 91: "SIGTERM durante um lote conclui o item atual e devolve o restante" (`@edge:QU-07`). Reason: the BDD harness cannot control OS processes; real coverage is proven in `test/concurrency/process-crash-and-shutdown.test.ts`.
- **Edge matrix IDs without `@edge:` tag:** The matrix [EDGE_CASE_MATRIX.md](audit/EDGE_CASE_MATRIX.md) lists 92 identifiers. In `test/features/*.feature`, 70 identifiers have the `@edge:` tag. The 22 identifiers without the tag are: `CF-01`, `CL-01`, `DB-01`, `DB-02`, `DB-03`, `DB-04`, `DB-05`, `EV-01`, `FA-01`, `LC-01`, `LC-02`, `LC-03`, `RS-01`, `RS-02`, `SC-01`, `SC-02`, `SC-03`, `SC-04`, `SC-05`, `SC-06`, `SC-07`, and `VW-01`. Each of these cases is tested by unit, integration, or concurrency suites, but was not expressed as Gherkin scenarios.
- **Load test environments:** The cloud baseline ([LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md)) was measured on a virtual machine by an agent. The local baseline ([LOAD_TEST_BASELINE.en.md](LOAD_TEST_BASELINE.en.md)) was measured on a separate physical machine. Both measurements took place on distinct computing environments with different hardware. Do not compare one measurement with the other.
- **Mutation testing:** Mutation testing results evaluated against `test/concurrency/distributed-contention.test.ts` (recorded in [TEST_STRATEGY.en.md](TEST_STRATEGY.en.md), section "Mutation evidence"):
  - Mutant M1 (removing pessimistic row lock `FOR UPDATE` in `findForUpdate`): Killed. The test without retries failed with three lost updates.
  - Mutant M2 (removing single-reversal guard in `TransactionSettlement`): Killed. The refund with rollbacks test and the test without retries failed.
  - Mutant M3 (removing `SKIP LOCKED` clause in outbox claim): Survived. The mutant is equivalent in terms of safety: the second publisher waits on row lock and re-evaluates lease condition without corrupting data. Because no test measures wait duration, the mutant survived and is recorded as a known gap.
  - Mutant M4 (removing expired lease check in outbox): Killed. The two-publishers test failed with 61 duplicate claims.

## 7. Simulated reviews

History of simulated reviews with internal estimated scores (not an evaluation panel score):

### 7.1 Round 1 (Invariant Review and Adversarial Audit)

- **Estimated score:** 80/100 in invariant review ([INVARIANT_REVIEW.en.md](INVARIANT_REVIEW.en.md)) and 85/100 in adversarial audit ([FINDINGS.md](audit/FINDINGS.md)), both marked as internal estimates.
- **Highest severity findings and fixes:**
  - Duplicate stake credit across multiple WINs or REFUND after result: resolved with unique index in commit `ce1cb62`.
  - Missing relational validation for currency and round in database: resolved with composite foreign keys and constraints in commit `f9eb95b`.
  - API lacking per-provider access control: resolved with API key authentication in commit `6ff6891`.
  - F-01 (malformed envelope stalling outbox): resolved by migration 9 in commit `2905535`.
  - F-02 (missing idempotency key in message identity): resolved by fingerprint hash in commit `2ec4d5e`.
  - F-04 (slow batch exposing in-flight messages): resolved with batch extension in commit `b398e22`.
  - F-05 (test fault hooks in production code): resolved by dependency composition in commit `489df8b`.
  - F-13 (permanent failure in held reference stalling worker): resolved with transition to `FAILED` in commit `c8ffbcc`.
  - F-14 (slow message redelivered after window): resolved with periodic visibility renewals in commit `6b3b23e`.
  - F-15 and F-07 (deadlines and leases relying on host clock): resolved using database `now()` in commits `fc3862c` and `433ebe2`.

### 7.2 Round 2 (Simulated Review and Quality Round)

- **Estimated score:** 90/100, marked as internal estimated target in [REVISAO_SIMULADA.md](audit/REVISAO_SIMULADA.md).
- **Highest severity findings and fixes:**
  - F-06 (divergent balance accepted by direct SQL update): resolved by migration 12 with balance agreement triggers in commit `c5ddca9`.
  - Coupling in infrastructure ports: resolved by segregating ports in `application/ports/` and separating inbound/outbound flows in commit `ef390fe`.
  - Missing `retries_total` metric (§12): implemented and exposed at `/metrics` in commit `4ee8f72`.
  - Absence of executable BDD suite linked to edge matrix: implemented with 73 Gherkin scenarios in `test/features/` in commits `3620d74` and `c8320ea`.

### 7.3 Round 3

Round 3 of the simulated review has not yet been conducted.
