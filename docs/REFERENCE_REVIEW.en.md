# Review of public reference implementations

> English reference copy. The primary version, in Portuguese, is [REFERENCE_REVIEW.md](REFERENCE_REVIEW.md).

This document records the comparative analysis between this project and public implementations of the same challenge, based on static source code reading and systematic practice extraction. The text documents the screening criteria, the identified practices, the adopted solutions with their respective evidentiary commits, the rejected approaches, and the verification boundaries.

## 1. What was compared

Reference identification started from 165 candidate repositories retrieved via the GitHub API (recorded in `scratchpad/forks-candidates.tsv`). All candidates underwent automated file tree screening on the default branch (`scratchpad/triagem-forks.sh`), tallying the presence of specific implementation signals:

- **Outbox or inbox signals:** 133 repositories contained occurrences in their file paths (column 4 of `scratchpad/forks-triagem.tsv`).
- **SQS or FIFO messaging signals:** 138 repositories contained occurrences (column 6 of `scratchpad/forks-triagem.tsv`).
- **Gherkin specifications (`.feature`):** 0 repositories contained files with this extension (column 5 of `scratchpad/forks-triagem.tsv`).
- **Valid inspected trees:** 165 repositories returned readable tree structures (column 3 of `scratchpad/forks-triagem.tsv`).

From the initial screening, 128 detailed repository notes were produced through static reading of local read-only clones (file count in `scratchpad/forks-notes/`). Non-default branch verification evaluated 124 notes (`scratchpad/ledger/fork-branches.summary.txt`), identifying 22 repositories with additional branches and 10 branches with commits ahead of the default branch (count from `scratchpad/ledger/fork-branches.tsv`, totaling 129 branch entries). Four branches with relevant divergent history had dedicated supplementary notes written (file count in `scratchpad/forks-notes-branches/`).

Content filtering in `scratchpad/ledger/filter.tsv` evaluated 121 repositories with local clones: 115 were retained for practice extraction (107 at Tier A with infrastructure tests and SQL migrations, 5 at Tier B with at least 5 test files, and 3 at Tier C with structured code), and 6 were classified as lacking actionable implementation due to absent domain logic or bare scaffolds. Systematic extraction categorized 28 thematic practice clusters in `scratchpad/ledger/clusters.tsv`.

## 2. Practices identified in the reviewed implementations

The practices mapped across the reviewed repositories were grouped according to the challenge evaluation areas:

### Financial correctness

- **Exact decimal representation:** 113 repositories use arbitrary-precision decimal libraries or numeric mappings without precision loss (`money_decimal_exact` cluster in `scratchpad/ledger/clusters.tsv`). Other forks adopt integer fractional units (`bigint`) converting text strings.
- **Financial integrity triggers at commit time:** 27 repositories employ deferred constraint triggers (`CONSTRAINT TRIGGER DEFERRABLE`) in the relational database to enforce strict consistency between wallet balance and ledger entry history at commit time (`deferred_balance_ledger_trigger` cluster in `scratchpad/ledger/clusters.tsv`).
- **Balance reconciliation routines:** 43 repositories maintain reconciliation queries or views for periodic balance auditing against ledger sums (`reconciliation` cluster in `scratchpad/ledger/clusters.tsv`).
- **Cryptographic chaining in the ledger:** 3 repositories record row-by-row chained hashes to detect tampering in accounting history (`ledger_hash_chain` cluster in `scratchpad/ledger/clusters.tsv`).
- **Double-entry bookkeeping journal:** 7 repositories introduce a formal chart of accounts with house clearing accounts (`double_entry_journal` cluster in `scratchpad/ledger/clusters.tsv`).

### Concurrency

- **Pessimistic row locking on wallets:** Predominant use of `SELECT ... FOR UPDATE` on wallet rows to serialize contended financial transactions.
- **Lock and statement wait limits:** 37 repositories configure transactional lock timeouts (`lock_timeout`) and execution timeouts (`statement_timeout`) to prevent unbounded stalls under high contention (`lock_timeout_statement_timeout` cluster in `scratchpad/ledger/clusters.tsv`).
- **Concurrent task coordination:** 120 repositories use `FOR UPDATE SKIP LOCKED` clauses combined with leases and fencing tokens for distributed claiming of messages or events (`skip_locked_lease_fencing` cluster in `scratchpad/ledger/clusters.tsv`).

### Idempotency

- **Atomic inbox record and side-effect write:** 79 repositories persist the inbox record in the exact same database transaction that modifies financial state (`inbox_before_or_same_tx` cluster in `scratchpad/ledger/clusters.tsv`).
- **Payload conflict detection under identical key:** 85 repositories store a payload hash to reject incoming requests reusing idempotency keys with mismatched parameters (`payload_hash_conflict` cluster in `scratchpad/ledger/clusters.tsv`).
- **Message acknowledgment strictly after commit:** 47 repositories defer broker acknowledgment (ACK) until after relational transaction commit completes (`ack_after_commit` cluster in `scratchpad/ledger/clusters.tsv`).

### Messaging and failures

- **Outbox attempt cap and quarantine:** 67 repositories enforce retry caps on outbox publishing with a terminal state to isolate unrecoverable events without discarding records (`outbox_attempt_cap_quarantine` cluster in `scratchpad/ledger/clusters.tsv`). Conversely, around 20 notes report unbounded retry loops without caps.
- **Retention and purge of published events:** 44 repositories establish cleanup routines to purge outbox events after retention periods elapse (`outbox_retention_cleanup` cluster in `scratchpad/ledger/clusters.tsv`).
- **Visibility return upon process shutdown:** 83 repositories immediately restore message visibility (`changeMessageVisibility(0)`) for buffered in-flight messages upon receiving operating system termination signals (`shutdown_return_visibility` cluster in `scratchpad/ledger/clusters.tsv`).
- **DLQ delivery prior to original message deletion:** 80 repositories ensure failed messages are confirmed delivered to the dead-letter queue before removing the original message from the source queue (`dlq_send_before_delete_risk` cluster in `scratchpad/ledger/clusters.tsv`).
- **Reprocessing with external dependency handling:** 57 repositories provide specific workflows to reprocess transactions stalled on unresolved external references (`pending_reference_retry` cluster in `scratchpad/ledger/clusters.tsv`).
- **Explicit transport deadlines:** 108 repositories set strict network call timeouts on SQS client interactions (`sqs_request_timeout` cluster in `scratchpad/ledger/clusters.tsv`).
- **Circuit breaker mechanisms:** 4 repositories employ circuit breakers in messaging transport layers (`circuit_breaker` cluster in `scratchpad/ledger/clusters.tsv`).

### Modeling and architecture

- **Pure and isolated domain:** Strict separation of domain entities without coupling to web frameworks or ORMs.
- **Database privilege segregation:** 14 repositories configure restricted database roles (runtime user lacking `UPDATE`, `DELETE`, or `TRUNCATE` privileges on the ledger) separate from migration users (`least_privilege_db_roles` cluster in `scratchpad/ledger/clusters.tsv`).
- **Integrated external authentication:** 7 repositories introduce integration with external identity providers, OIDC, or JWT tokens (`keycloak_oidc_jwt` cluster in `scratchpad/ledger/clusters.tsv`).

### Testing

- **Multi-process concurrency testing:** 70 repositories evaluate system behavior using multiple simultaneous operating system processes competing over the same database (`multi_process_tests` cluster in `scratchpad/ledger/clusters.tsv`).
- **Abrupt crash simulation between commit and acknowledgment:** 100 repositories test resilience against abrupt termination (`SIGKILL` or forced crashes) between database commit and broker ACK (`sigkill_or_crash_between_commit_ack` cluster in `scratchpad/ledger/clusters.tsv`).
- **Load testing with dedicated tooling:** 9 repositories use tools such as k6 or Gatling to measure saturation limits (`load_test_k6_gatling` cluster in `scratchpad/ledger/clusters.tsv`).

### Observability

- **Prometheus metric exposition:** 117 repositories provide an operational metrics endpoint for Prometheus scraping (`prometheus_metrics` cluster in `scratchpad/ledger/clusters.tsv`).
- **Queue and outbox depth gauges:** 70 repositories expose gauges tracking outbox backlogs and dead-letter queue depths (`dlq_or_backlog_gauge` cluster in `scratchpad/ledger/clusters.tsv`).
- **Correlation identifier propagation in structured logs:** 7 repositories propagate correlation IDs across structured JSON log records (`correlation_id` cluster in `scratchpad/ledger/clusters.tsv`).
- **Readiness probe deadlines:** 107 repositories enforce timeouts and request aborts on health probes (`readiness_deadline_abort` cluster in `scratchpad/ledger/clusters.tsv`).
- **Migration status validation in health checks:** 4 repositories verify pending migration status within the readiness probe (`health_migrations_applied` cluster in `scratchpad/ledger/clusters.tsv`).

### Documentation

- Container-based execution instructions and architectural decision logging via ADRs.

## 3. What was adopted in this project

Based on practices identified across the references, the following solutions were implemented and verified in the repository:

1. **Deferred triggers verifying balance and ledger consistency:**
   - **Commit:** `c5ddca9` (`feat(ledger): impedir commit com saldo divergente do ledger`).
   - **Implementation:** Functions and constraint triggers `wallets_ledger_balance_check` and `wallet_ledger_entries_balance_check` in `src/shared/infrastructure/database/migrations/Migration20261101000012.ts`. The trigger defers checking until `COMMIT` and aborts transactions where wallet balance differs from the ledger history.
   - **Verification:** `test/integration/schema/ledger-balance-trigger.test.ts`.

2. **Wait limits on wallet locking and transactional statement execution:**
   - **Commit:** `4c58edb` (`fix(wagering): limitar a espera por trava de carteira`).
   - **Implementation:** Transactional `lock_timeout` (5 s) and `statement_timeout` (15 s) applied via `SET LOCAL` in `src/shared/infrastructure/database/mikro-orm-financial-unit-of-work.ts`. Mapping PostgreSQL error code `55P03` as a transient fault eligible for controlled redelivery.
   - **Verification:** `test/integration/wagering/lock-timeout.test.ts`.

3. **Outbox event quarantine and administrative requeue tooling:**
   - **Commit:** `216eb8f` (`feat(messaging): quarentena de eventos da outbox após N tentativas`).
   - **Implementation:** Configurable publishing retry limit transitioning exhausted events to `QUARANTINED` status in `src/modules/messaging/domain/outbox-message.ts` and `src/modules/messaging/infrastructure/mikro-orm-outbox.store.ts`, paired with the administrative utility `scripts/outbox-requeue.ts`.
   - **Verification:** `test/integration/messaging/outbox-quarantine.test.ts`.

4. **Scheduled retention cleanup for published outbox events:**
   - **Commit:** `e7af1dd` (`feat(messaging): limpar eventos publicados após a retenção`).
   - **Implementation:** Method `deletePublishedBefore` in the outbox store called on worker intervals (`src/worker/run-worker.ts`), supported by a partial index in `src/shared/infrastructure/database/migrations/Migration20261101000015.ts`.
   - **Verification:** `test/integration/messaging/outbox-retention.test.ts`.

5. **Immediate visibility restoration upon consumer shutdown:**
   - **Commit:** `98c39ac` (`fix(messaging): devolver mensagens não processadas ao encerrar`).
   - **Implementation:** Renewal loop cancellation and explicit visibility reset (`changeMessageVisibility(0)`) for buffered messages during graceful termination in `src/modules/messaging/application/inbound/wager-command-consumer.ts`.
   - **Verification:** `test/integration/messaging/consumer-shutdown.test.ts`.

6. **Strict transport deadlines and health probe timeouts:**
   - **Commit:** `8b3560a` (`fix(infra): prazos reais para chamadas SQS e readiness`).
   - **Implementation:** Enforced `requestTimeout` on SQS client connections (`src/shared/infrastructure/sqs/sqs-connection.ts`) and explicit deadline via `AbortSignal.timeout` in readiness checks (`src/health/health.service.ts`).
   - **Verification:** `test/integration/faults/sqs-deadlines.test.ts` and `test/e2e/health.test.ts`.

7. **Consolidated operational retries counter:**
   - **Commit:** `4ee8f72` (`feat(observability): contador retries_total exigido pela §12`).
   - **Implementation:** Unified Prometheus metric `retries_total` tagged by subsystem label in `src/shared/infrastructure/observability/prometheus-metrics.ts`.
   - **Verification:** `test/unit/docs/catalogos.test.ts`.

8. **Executable Gherkin specification suite under Bun:**
   - **Commit:** `3620d74` (`test(features): executar Gherkin sob Bun com cucumber-js`).
   - **Implementation:** 73 BDD scenarios across `.feature` specification files in `test/features/`, executed against real PostgreSQL instances without database test doubles.
   - **Verification:** Running `bun run test:features`.

## 4. What was rejected, and why

1. **Synchronous broker publication during database transactions:**
   - _Identified pattern:_ Observed in approximately 15 reviewed implementations. Broker API calls are executed while keeping the database connection open and wallet rows locked under pessimistic locks.
   - _Reason for rejection:_ Binds relational critical sections to external network latency and broker availability. Under concurrency contention or network fluctuations, this causes prolonged connection holding and risks database pool exhaustion. The project maintains decoupled dispatch via transactional outbox records persisted in the same atomic unit.

2. **Unbounded outbox retries without quarantine:**
   - _Identified pattern:_ Observed in approximately 20 implementations. Failed publishing attempts repeat indefinitely without iteration caps or terminal states.
   - _Reason for rejection:_ Messages failing due to schema divergence or payload errors consume CPU and IO cycles indefinitely, degrading publisher throughput and concealing broken records from operators.

3. **Domain monetary representation using `bigint` fractional units:**
   - _Identified pattern:_ Present across multiple repositories operating on cents via integers and converting text strings with string replacement routines.
   - _Reason for rejection:_ String parsing to convert scales introduces maintenance fragilities. An immutable value object backed by `decimal.js` guarantees exact arbitrary-precision arithmetic, strict two-decimal scale validation, and clean alignment with PostgreSQL `NUMERIC(20,2)`. Documented in [docs/adr/0002-money-representation.en.md](adr/0002-money-representation.en.md).

4. **Circuit breaker pattern on transport calls:**
   - _Identified pattern:_ Present in 4 repositories (`circuit_breaker` cluster in `scratchpad/ledger/clusters.tsv`).
   - _Reason for rejection:_ Adds volatile distributed state management without functional gain under the evaluation specification (§14). Exponential backoff with jitter and dead-letter queues resolve transport faults deterministically.

5. **Integrated authentication infrastructure via Keycloak, OIDC, or JWT:**
   - _Identified pattern:_ Present in 7 repositories (`keycloak_oidc_jwt` cluster in `scratchpad/ledger/clusters.tsv`).
   - _Reason for rejection:_ The challenge specification mandates lightweight client authentication via static API keys in HTTP headers (`x-api-key`). Introducing external identity providers adds operational overhead without corresponding evaluation points (§1 and §3).

6. **Cryptographic hash chaining on the ledger:**
   - _Identified pattern:_ Present in 3 repositories (`ledger_hash_chain` cluster in `scratchpad/ledger/clusters.tsv`).
   - _Reason for rejection:_ Accounting immutability is guaranteed at the database engine level via restrictive triggers against `UPDATE`, `DELETE`, and `TRUNCATE`, reinforced by deferred balance consistency triggers. Chained hash validation adds computational complexity without superseding relational integrity guarantees.

7. **Double-entry bookkeeping journal with house clearing accounts:**
   - _Identified pattern:_ Present in 7 repositories (`double_entry_journal` cluster in `scratchpad/ledger/clusters.tsv`).
   - _Reason for rejection:_ The financial invariants of the challenge (§6) mandate linear wallet balance tracking with previous balance, post balance, and correlation to external wager transactions. Introducing auxiliary house accounts exceeds required modeling without specification requirement.

8. **Deleting source messages prior to DLQ write confirmation:**
   - _Identified pattern:_ Observed in consumer implementations where source message deletion from the broker executes independently of DLQ delivery confirmation.
   - _Reason for rejection:_ If the DLQ call fails due to network partition after the source message is deleted, the message is permanently lost. Our consumer ensures source deletion occurs strictly after successful dead-letter delivery.

## 5. What was not verified

1. **Third-party code execution:** No external repository code, test, or script was installed, built, or executed (`npm install`, `bun test`, compiler commands, or container startup). Analysis was strictly restricted to static source reading and documentation examination, adhering to security guidelines against untrusted code execution.
2. **Third-party test counts and test coverage claims:** Test tallies and code coverage percentages asserted in external READMEs were not audited or verified via test execution.
3. **Screened forks lacking substantial implementations:** Out of 165 candidate repositories, 37 were not analyzed in depth due to missing domain or migration files during automated screening, and 6 were excluded during qualitative filtering in `scratchpad/ledger/filter.tsv` due to absence of operational code.
4. **Non-default branches without commits ahead:** Of the 129 branch records cataloged in `scratchpad/ledger/fork-branches.tsv`, 119 had zero commits ahead of the default branch (`ahead_by=0`) and were not subjected to individual file inspections.
5. **Performance benchmarks against other implementations:** No throughput, latency, or concurrency benchmarks were run against third-party implementations. Performance measurements within this project reflect internal comparisons of architectural alternatives under controlled environments, recorded in [docs/audit/PERFORMANCE_COMPARISON.md](audit/PERFORMANCE_COMPARISON.md).
