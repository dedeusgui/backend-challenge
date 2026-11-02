# Invariant, constraint and decision review

> English reference copy. The main version, in Portuguese, is [INVARIANT_REVIEW.md](INVARIANT_REVIEW.md).

> **Appendix.** The owner's review of every invariant and constraint. The decisions confirmed on 2026-11-01 are
> listed in [ARCHITECTURE.en.md](../ARCHITECTURE.en.md) section 13.

Historical record of the finalization branch review, before its integration into `main`. The review covered every invariant of the
requirements matrix, every database constraint in the migrations, and every
decision in `docs/adr/` and `ARCHITECTURE.md` section 13.

The results and commits below describe that snapshot; they are not a gate for the current HEAD.

Each invariant is listed with the point that enforces it and the test that proves it. Test names
are the ones in the cited files. Matrix labels are short descriptions, and each cites a file that
exists (checked for this review). Where the matrix and the code disagreed, the code was right and
the matrix was corrected.

## 0. The finalization review, at the head of the branch

This section repeats the review on the code of the finalization branch. It lists each invariant the brief names, the
point that enforces it, and the test that proves it at HEAD. Where a check was made by reading the code, the
text says so. Every test named here passed in the final gate.

| Invariant                                                  | Enforced by                                                                                             | Proven by                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Balance never negative                                     | `Wallet.canDebit` before the debit; `balance >= 0` in the database                                      | `wallet.test.ts`; `schema-constraints`; `hot-wallet: mixed operations`                                  |
| Credits and debits not duplicated                          | one processed settlement per reference (partial unique index); one ledger row per (wallet, transaction) | `hot-wallet`, `distributed-contention`, `duplicate-deliveries`                                          |
| Ledger immutable                                           | triggers that refuse UPDATE, DELETE and TRUNCATE                                                        | `schema-constraints: ledger is immutable`                                                               |
| Uniqueness per provider and external identity              | `UNIQUE (provider, idempotency key)` and `UNIQUE (provider, external id)`                               | `schema-constraints`; `distributed-contention: one key, three payloads`                                 |
| Canonical payload hash                                     | sorted keys and no whitespace, at every level; SHA-256 of that form; no transport metadata in it        | `wager-payload-hash.test.ts`: the encoding, the digest, the field order, and an absent reference        |
| Out-of-order references                                    | `PENDING_REFERENCE` with a persisted schedule; the worker re-reads under the wallet lock                | `pending-reference: six workers racing over six held refunds`                                           |
| Reversals                                                  | one reversal per reference, whatever its kind; an overdraw is `REVERSAL_WOULD_OVERDRAW`                 | `process-wager-transaction: one reversal per bet`; `distributed-contention: a refund and two rollbacks` |
| Concurrency across three or more processes                 | the wallet row lock, the version guard, and the unique constraints                                      | `three-processes`; `distributed-contention`                                                             |
| Atomicity of wallet, ledger, transaction, inbox and outbox | one unit of work; the outbox and inbox rows are written in it                                           | `fault-injection: a crash before commit leaves no trace`                                                |
| HTTP answers coherent with the financial state             | `statusOf` maps each state to one status; a replay carries the stored snapshot                          | `wagering-http`; the replay contract in `ARCHITECTURE.md` section 6                                     |

Changes in this round, each with its commit: the queue refuses a non-UUID wallet id as HTTP does (`d437452`); a
dead-letter copy keeps one copy inside the broker's window (`ebc9589`); a duplicate that waits for the lock records
no second inbox row (`a10fd11`); the outbox orders a claimed batch by due time (`89b7bc1`); the lock path makes fewer
round trips, and its outcome query uses the partial indexes (`9e8dabe`). Each change has a test that failed before
it and passes after it.

Checked by reading the code, not by a test: that `Wallet.credit` does not check the database's maximum itself (the
settlement checks `canCredit` first, and the database refuses the rest); that the reference worker takes the wallet
lock before it re-reads a held transaction; that the consumer acknowledges only after the unit of work returns.

### Read-only SQL verification

The verifier `scripts/check-financial-invariants.ts` runs `scripts/financial-invariants.sql` inside a `READ ONLY`
transaction. With PostgreSQL available and the schema migrated, run it from the repository root:

```bash
bun run check:financial-invariants
```

`DATABASE_URL` can point to another database; when unset, the command uses the project's local default. The SQL checks
financial invariants `INV-01` through `INV-11` and additional database-structure checks `DB-01` through `DB-11`.
`INV-12` only reports the migration count (current expectation: 17) and does not fail when it differs.

This verifier is a point-in-time inspection of database state and structure. It does not by itself prove that the
TypeScript `Money` type is used, that there is no global lock, that every flow applies the correct lock, or that
publication happens after commit. Those behaviors require code review and the corresponding tests. The SQL result also
does not replace the test gate or a CI run.

## 1. Defects found in this review, and their fixes

| #   | Defect                                                                     | Fix                                                                                                                                                  | Commit    |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Two WINs on one BET both credited the wallet: a BET could pay twice        | One PROCESSED result per BET: settlement check and partial unique index `wager_one_processed_settlement_per_reference`                               | `ce1cb62` |
| 2   | A REFUND after a WIN or LOSS of the same BET was applied                   | REFUND only for a BET with no result (`REFERENCE_ALREADY_SETTLED`)                                                                                   | `ce1cb62` |
| 3   | A WIN or LOSS could omit its BET, so no result could be tied to a BET      | Migration 3 required the BET for WIN and LOSS. Migration 6 makes it optional, as the specification says, and a named result is still checked. See D1 | `ce1cb62` |
| 4   | The database accepted a zero amount for every kind                         | `wager_amount_shape`: positive, except LOSS                                                                                                          | `f9eb95b` |
| 5   | The database did not check that a reference is in the same round           | `wager_reference_round_key` and the reference foreign key include `round_id`                                                                         | `f9eb95b` |
| 6   | The database did not check that a ledger entry has its wallet's currency   | `ledger_wallet_currency_fk`                                                                                                                          | `f9eb95b` |
| 7   | A draft rule tied a transaction's player and currency to its wallet        | Reverted. A mismatch is a persisted REJECTED row by design (ARCHITECTURE section 13). The domain checks it                                           | `f9eb95b` |
| 8   | A crashed API or worker container stayed down (no restart policy)          | `restart: unless-stopped` for `api` and `worker`                                                                                                     | `8e807a8` |
| 9   | The API accepted any caller, and any caller could name any provider        | API keys with two roles and provider scope (ADR 0007)                                                                                                | `6ff6891` |
| 10  | Process-level crash before commit and SIGTERM during a batch were unproven | Both now run in real worker processes. Neither needed a production change                                                                            | `26cfc21` |

Defects 1 and 2 were double credits. Defect 3 made 1 and 2 impossible to check. Defects 4 to 6
were rules that only the domain enforced. Defect 7 was caught by two existing tests, not by
reasoning, which is why the full gate ran before each commit.

## 2. Decisions and owner questions

These are interpretations, not literal facts from the specification. D1–D4 were confirmed on 2026-11-01;
D5 and the remaining limitations are recorded so the implementation does not imply guarantees it lacks.
Each decision is written into ARCHITECTURE section 13 and changes behaviour that a provider sees.

| #   | Decision                                                                                                                                        | Why                                                                                                                              | Risk if the owner disagrees                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | WIN and LOSS may omit a reference; if they name a BET, they validate the full context. The specification makes the reference optional (6.3, 7). | Association is not inferred from roundId or a heuristic. An unreferenced WIN does not demonstrate settlement uniqueness per BET. | Confirmed on 2026-11-01. An unreferenced WIN cannot be linked to the BET or prove settlement uniqueness per BET.                                                                            |
| D2  | ROLLBACK applies in every state of the transaction it reverses, with or without a result.                                                       | Confirmed on 2026-11-01: ROLLBACK is an individual transaction reversal.                                                         | After a WIN, a ROLLBACK of the BET returns the stake and the WIN stays credited. This economic effect was accepted on 2026-11-01; the WIN needs its own ROLLBACK, with no implicit cascade. |
| D3  | REFUND only for a PROCESSED BET with no result; refused after WIN, LOSS or conflicting reversal. BET does not reopen after reversing REFUND.    | Confirmed on 2026-11-01.                                                                                                         | A provider sends a ROLLBACK of the WIN instead.                                                                                                                                             |
| D4  | A reference admits at most one effective reversal, whatever its kind. Specification rule 4 says "pelo mesmo tipo de operação".                  | Rule 4 read literally allows REFUND and then ROLLBACK of one BET, which credits the stake twice.                                 | If the owner reads rule 4 literally, the double credit returns. It is blocked by `wager_one_processed_reversal_per_reference`.                                                              |
| D5  | Authentication is API keys with two roles, not an external identity provider. The specification expects an IdP (section 2).                     | ADR 0007: a simple scheme that the project needs. A keycloak or zitadel container was judged too heavy for this build.           | Keys do not expire, rotate on a schedule, or travel over TLS in this build. A production deployment needs the IdP the specification suggests.                                               |
| D6  | A currency or player mismatch is a persisted REJECTED row, checked only by the domain.                                                          | Auditability (ARCHITECTURE section 13). A foreign key would refuse the row.                                                      | A writer that bypasses the domain could store a mismatched row without a rejection code. No such writer exists in the code.                                                                 |

**Re-evaluation of D2, D3 and D4 (this review).** Each one was checked against the code and tests and confirmed on 2026-11-01,
and against the global invariant that no credit is duplicated.

- **D4, once per reference.** Kept. Read literally, rule 4 allows a REFUND and then a ROLLBACK of one
  BET, which credits the stake twice, so the invariant prevails. The stricter reading has a consequence
  that is now tested: a rolled-back refund does not free its BET, and a second reversal of the BET is
  `REFERENCE_ALREADY_REVERSED`. A finer rule that counts net reversals could allow that case without a
  double credit. It is not built, because no requirement asks for it.
- **D3, a REFUND only for a BET with no result.** Kept, and now enforced by the database as well
  (migration 8). A refund and a result cannot both be processed for one BET, in either order. The
  reverse order (a WIN after a refund) is refused by the reversal rule.
- **D2, a ROLLBACK in every state.** Kept as recorded, and its economic effect was accepted on 2026-11-01. After a WIN, rolling back the BET returns the stake and keeps the win, so the player keeps
  both. No credit is duplicated by identity or by amount: the stake returns once (D4), and the win is
  credited once. The alternative is to refuse a ROLLBACK of a BET that has a processed WIN, so that the
  provider rolls back the WIN first, as D3 does for refunds. The 2026-11-01 confirmation accepts this effect: an individual reversal, with no implicit cascade.

The duplicate-credit paths that remain are the unnamed WIN (D1): a WIN that names no BET can be
credited again when the provider resends it under a new external id. That is by design, because each
external id is an operation (ARCHITECTURE section 7).
| D7 | A worker restarts after a crash with a fixed one-second pause. There is no exponential backoff for loops. | Simple, and each loop logs its failure. | During a long outage each loop logs once a second. |

## 3. Invariants

Enforcement points: **DB** is a database constraint, **Domain** is an entity or value object,
**Unit of work** is the transaction and the wallet lock, **Queue** is the consumer or publisher,
**Test-only** is a seam that production never passes.

### 3.1 Money, idempotency and concurrency

| ID     | Invariant                                | Enforced by                                                              | Proven by                                                                                                                                |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| INV-01 | No duplicate credit or debit             | Unit of work (wallet lock), DB unique keys, domain                       | `test/concurrency/hot-wallet.test.ts` (exactly one BET of 80.00 on 100.00, mixed hot wallet); `test/concurrency/three-processes.test.ts` |
| INV-02 | Ledger and balance always agree          | Domain (`Wallet.debit`, `credit`), DB arithmetic CHECK, reconciliation   | `test/integration/persistence/wallet-persistence.test.ts`; `test/e2e/queries-http.test.ts` (reconciliation)                              |
| INV-03 | Money is never a `number`                | `Money` type, `AMOUNT_PATTERN`, `NUMERIC(20,2)`                          | `test/unit/shared/domain` money tests, `rejects a JavaScript number`                                                                     |
| INV-04 | Idempotency is persistent, not in memory | DB unique `(provider_id, idempotency_key)`                               | `test/integration/wagering/process-wager-transaction.test.ts`, `a repeated identical request replays`                                    |
| INV-05 | Nothing is published before its commit   | Outbox written in the same transaction                                   | `test/concurrency/three-processes.test.ts`, `test/integration/messaging/wager-command-consumer.test.ts`                                  |
| INV-06 | Ledger is never overwritten or deleted   | Trigger `wallet_ledger_entries_no_update_or_delete`, no-truncate trigger | `test/integration/schema/schema-constraints.test.ts`, `is append-only: UPDATE / DELETE / TRUNCATE is refused`                            |
| INV-07 | No global lock between wallets           | Row lock on one wallet                                                   | `test/concurrency/hot-wallet.test.ts`, `distinct wallets operated in parallel`                                                           |
| INV-08 | No unguarded read-calculate-update       | `FOR UPDATE` plus version guard in `save`                                | `test/integration/persistence`, `refuses a save whose expected version is stale`                                                         |
| INV-09 | Correct with several instances           | Row lock and DB constraints, not memory                                  | `test/concurrency/three-processes.test.ts`                                                                                               |
| INV-10 | The database refuses bad rows            | Constraints listed in section 4                                          | `test/integration/schema/schema-constraints.test.ts` (the probes in this file)                                                           |
| INV-11 | The unit of concurrency is the wallet    | `FOR UPDATE` on the wallet row, taken first                              | `test/concurrency/hot-wallet.test.ts`                                                                                                    |

### 3.2 Wallet and ledger

| ID     | Invariant                                                    | Enforced by                                                       | Proven by                                                                                                  |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| WAL-01 | At most one wallet per player and currency                   | DB `wallets_player_currency_key`                                  | `allow only one wallet per player and currency`                                                            |
| WAL-02 | Balance is never negative                                    | DB `balance >= 0`, domain `canDebit`                              | `reject a negative balance`, `refuses to debit more than the balance`                                      |
| WAL-03 | Every balance change has a ledger entry, and the reverse     | Unit of work (wallet, ledger and outbox together), reconciliation | `the ledger reconstructs the materialized balance after mixed movements`                                   |
| WAL-04 | The operation's currency is the wallet's currency            | Domain (`WALLET_CURRENCY_MISMATCH`), DB ledger FK                 | `a currency other than the wallet currency is REJECTED`, `rejects a debit in a different currency`         |
| WAL-05 | `version` starts at 1 and changes only with a balance change | Domain, DB `version >= 1`                                         | `a zero initial balance opens at version 1`, `a zero-amount movement is rejected`                          |
| WAL-06 | No lost update under concurrency                             | Version guard and `FOR UPDATE`                                    | `test/concurrency/hot-wallet.test.ts`                                                                      |
| LED-01 | Ledger is immutable and append-only                          | Triggers                                                          | `is append-only: UPDATE is refused`, `DELETE is refused`, `TRUNCATE is refused`                            |
| LED-02 | `balanceBefore ± money == balanceAfter`                      | Domain `WalletLedgerEntry.create`, DB `ledger_arithmetic`         | `rejects an entry whose arithmetic does not balance`                                                       |
| LED-03 | At most one entry per wallet per transaction                 | DB `ledger_one_entry_per_wallet_transaction`                      | `test/integration/schema`, `one entry per transaction`                                                     |
| LED-04 | LOSS and REJECTED write no ledger entry                      | Domain and settlement                                             | `a LOSS is processed without moving the balance, the ledger`, `a BET the balance cannot cover is REJECTED` |

### 3.3 Transactions and business rules

| ID     | Invariant                                                                           | Enforced by                                                                 | Proven by                                                                                              |
| ------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| WTX-01 | The six kinds, and only those                                                       | DB `kind` CHECK, `KIND_RULES`                                               | `transaction kinds`                                                                                    |
| WTX-02 | Explicit states, and terminal states do not reopen                                  | Domain state machine, DB `wager_status_shape`                               | `PENDING → PROCESSED records the resulting balance`, `markPendingReference is only valid from PENDING` |
| WTX-03 | OPENING is never submitted by a provider or a queue message                         | `isExternallySubmittable`, `externallySubmittable` table                    | `OPENING is internal and cannot be submitted externally`                                               |
| WTX-04 | The same key with a different payload is a conflict, never a replay                 | Payload hash, DB unique key                                                 | `the same idempotency key with a different payload is a conflict`                                      |
| BR-01  | BET debits and refuses an insufficient balance                                      | Domain and settlement                                                       | `a BET the balance cannot cover is REJECTED`                                                           |
| BR-02  | WIN credits; it names the BET it settles when it can (D1)                           | `KIND_RULES`, DB `wager_reference_shape`                                    | `a WIN credits the wallet`, `a WIN or LOSS without the reference of its BET is an invalid transaction` |
| BR-03  | LOSS moves no balance; it names its BET when it can (D1)                            | `KIND_RULES`, DB `wager_reference_shape`                                    | `a LOSS is processed without moving the balance`                                                       |
| BR-04  | REFUND reverses a BET once, and only one with no result (D3)                        | Settlement, `mustBeUnsettled`, `wager_one_processed_reversal_per_reference` | `a REFUND is refused once the BET has a WIN`, `a REFUND of a BET without a result is applied`          |
| BR-05  | ROLLBACK reverses a BET, WIN or REFUND once, in every state (D2, D4)                | Settlement, `wager_one_processed_reversal_per_reference`                    | `a ROLLBACK applies after the BET has a WIN`, `a ROLLBACK applies after the BET has a LOSS`            |
| BR-06  | A reference matches the provider, player, wallet, currency, round, amount and kind  | Domain (`evaluateReference`), DB composite FKs (provider, wallet, round)    | `a reference that is itself still pending`, `a REFUND may only reference a BET`                        |
| BR-07  | A reversal's amount equals its reference's amount                                   | Domain (`amountMustMatch`)                                                  | `a reversal must match the referenced amount exactly`                                                  |
| BR-08  | REJECTED changes no balance and writes no ledger                                    | Settlement                                                                  | `a BET the balance cannot cover is REJECTED, with no balance or ledger effect`                         |
| BR-09  | Replay returns the original result, with the balance seen then                      | Stored `resulting_balance`                                                  | `a repeated identical request replays the original result and the balance seen back then`              |
| BR-10  | A missing reference holds the transaction as PENDING_REFERENCE                      | Settlement, `markPendingReference`                                          | `a REFUND that arrives before its BET waits as PENDING_REFERENCE`                                      |
| BR-11  | A reversal that would overdraw is REVERSAL_WOULD_OVERDRAW, not INSUFFICIENT_BALANCE | Settlement                                                                  | `a ROLLBACK of a WIN the balance has already spent is REVERSAL_WOULD_OVERDRAW`                         |
| BR-12  | Additional interpretations are documented                                           | `ARCHITECTURE.md` section 13                                                | Section 13 is reviewed in section 2 of this document                                                   |
| BR-13  | A BET has at most one PROCESSED result (WIN or LOSS)                                | Settlement, `wager_one_processed_settlement_per_reference`                  | `a BET pays once`, `a LOSS cannot be recorded on a BET that already has a WIN`                         |

### 3.4 References, retries and outbox

| ID               | Invariant                                                 | Enforced by                                                | Proven by                                                                                                             |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| REF-01           | Held transactions retry with exponential backoff          | `referenceRetryDelayMs`, DB `reference_next_attempt_at`    | `retries are scheduled with backoff`, `test/unit/wagering/domain/reference-retry-policy.test.ts` (cap mutation fails) |
| REF-02           | The attempt limit is explicit                             | `MAX_REFERENCE_ATTEMPTS = 6`, DB `reference_attempts`      | `after the attempt limit the transaction is REJECTED with REFERENCE_NOT_FOUND`                                        |
| REF-03           | An exhausted reference is REJECTED and announced          | Settlement                                                 | `after the attempt limit the transaction is REJECTED ... and announced`                                               |
| REF-04           | Restart and crash during resolution apply the effect once | Persisted schedule, transaction rollback                   | `a restarted worker continues the persisted schedule`; `fault: a crash while resolving a held reference rolls back`   |
| MSG-01           | The queue consumer uses the HTTP use case                 | Same `ProcessWagerTransaction`                             | `test/integration/messaging/wager-command-consumer.test.ts`                                                           |
| MSG-02           | The inbox deduplicates by consumer and message id         | DB primary key `(consumer_name, message_id)`, payload hash | `deduplicates inbox messages by consumer and message id`                                                              |
| MSG-03           | ACK only after commit                                     | Consumer order                                             | `a crash after commit and before the acknowledgement is recovered by redelivery`                                      |
| MSG-04           | Business, transient and permanent failures are classified | `failure-classification.ts`                                | `a malformed message is dead-lettered` (permanent); `a transient failure leaves the message in the queue` (transient) |
| MSG-05           | A limit of deliveries before the DLQ                      | Broker redrive `maxReceiveCount = 10`                      | `the command queue redrives to the dead-letter queue after ten deliveries`                                            |
| MSG-06           | SIGTERM finishes or returns the batch                     | `runWorker` stop signal                                    | `SIGTERM stops the worker gracefully with exit code 0`                                                                |
| MSG-07           | Redelivery does not duplicate an effect                   | Inbox and idempotency                                      | `a redelivered message with the same messageId does not apply its effect twice`                                       |
| MSG-08           | A transient failure does not stop the worker              | `runPass` guard in `run-worker.ts`                         | `a failing pass in any loop is logged, and that loop keeps running`                                                   |
| MSG-09           | A crash before commit leaves no trace                     | Transaction rollback                                       | `a worker killed inside a transaction, before commit, leaves no trace`                                                |
| MSG-10           | A SIGTERM during a batch finishes the batch               | Stop checked between batches                               | `a worker stopped with SIGTERM during a batch`                                                                        |
| OUT-01 to OUT-04 | The four events are published, once each, after commit    | Outbox written in the transaction                          | `publishes each committed event once, and marks it published`                                                         |
| OUT-05           | The envelope is a typed abstract class                    | `IntegrationEvent`                                         | `serializes identity, correlation, ISO time, version and event type`                                                  |
| OUT-06           | Concurrent publishers claim disjoint events               | `FOR UPDATE SKIP LOCKED`, lease                            | `concurrent publishers claim disjoint events, so no event is sent twice`                                              |
| OUT-07           | At-least-once with a stable event id                      | Outbox primary key, SQS deduplication id                   | `a crash after the broker accepted an event ... republishes with the same event id`                                   |
| OUT-08           | Expired leases are recovered                              | `claimDue` with `lease_until`                              | `an event leased by a crashed publisher is published once its lease expires`                                          |

### 3.5 API, observability and authentication

| ID               | Invariant                                                                            | Enforced by                          | Proven by                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| API-01 to API-11 | Status codes, errors, cursors, reconciliation and health (ARCHITECTURE section 10)   | Controllers, `toErrorResponse`       | `test/e2e/*.test.ts` (32 tests)                                                                          |
| API-11           | Readiness checks PostgreSQL and SQS, and fails when SQS is unreachable               | `HealthService`                      | `readiness is 503 and names the failing dependency when SQS is unreachable`                              |
| OBS-01           | Structured logs with the correlation fields                                          | `OperationLog`, `formatOperationLog` | `test/unit/observability/structured-log.test.ts`                                                         |
| OBS-02           | No amount or payload in a log; errors are logged by class and code, never by message | `OperationLog` type, `describeError` | `cannot carry a money field`, `gives the class name and the code of an error, and never its message`     |
| OBS-03           | Counters for status, duplicates, retries, DLQ, lock conflicts, lag, latency          | `MetricsRegistry`                    | `counts processed transactions and idempotent replays of this process` (`test/e2e/metrics-http.test.ts`) |
| OBS-04           | Liveness and readiness are separate                                                  | `HealthController`                   | `liveness is 200 and does not depend on any dependency`                                                  |
| AUTH-01          | Every route needs a valid key, except health                                         | `ApiKeyGuard`, `@Public()`           | `test/e2e/auth-http.test.ts`                                                                             |
| AUTH-02          | A provider acts only for its own provider id                                         | `requireProviderScope`               | `test/e2e/auth-http.test.ts`, `test/concurrency/three-processes.test.ts`                                 |
| AUTH-03          | Wallet and metrics routes are for operators only                                     | `@OperatorOnly()`, guard             | `a provider key cannot open a wallet or read metrics: 403 FORBIDDEN`                                     |
| AUTH-04          | The key is stored only as a SHA-256 hash, and a revoked key is refused               | `api_clients.key_hash`, `revoked_at` | `no column of any row holds the plaintext key`, `a revoked key is no longer accepted`                    |

## 4. Database constraints

| Table                   | Constraint                                                                              | Rule                                                                                         | Proven by                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `wallets`               | `wallets_player_currency_key` (unique)                                                  | one wallet per player and currency                                                           | WAL-01 probe                                                                                                    |
| `wallets`               | `currency` CHECK, `balance >= 0`, `version >= 1`                                        | ISO shape, no negative balance, version starts at 1                                          | WAL-02, WAL-05 probes                                                                                           |
| `wallets`               | `wallets_id_currency_key` (unique)                                                      | target of the ledger currency FK (migration 5)                                               | ledger currency probe                                                                                           |
| `wager_transactions`    | `wager_external_identity_key`, `wager_idempotency_key`                                  | unique external id and idempotency key per provider                                          | INV-04, WTX-04 probes                                                                                           |
| `wager_transactions`    | `wager_reference_target_key`, `wager_reference_wallet_key`, `wager_reference_round_key` | unique keys used as targets of composite FKs                                                 | reference probes                                                                                                |
| `wager_transactions`    | `wager_reference_fk` (`reference_transaction_id, provider_id, wallet_id, round_id`)     | a reference is in the same provider, wallet and round (migration 5)                          | `a reference must be a transaction of the same round`; `rejects a reference to a transaction of another wallet` |
| `wager_transactions`    | `wager_reference_shape`                                                                 | REFUND and ROLLBACK name a reference; BET and OPENING do not; WIN and LOSS may (migration 6) | `a WIN or a LOSS may omit the reference of its BET`                                                             |
| `wager_transactions`    | `wager_resolved_reference_shape`                                                        | a resolved reference has its external id                                                     | probe in `schema-constraints.test.ts`                                                                           |
| `wager_transactions`    | `wager_status_shape`                                                                    | PROCESSED needs `processed_at` and a balance; REJECTED and FAILED need a code                | `rejects a PROCESSED transaction without processed_at and resulting balance`                                    |
| `wager_transactions`    | `wager_pending_reference_schedule`                                                      | a held row has a next lookup time and the balance it was held with (migration 7)             | reference probes                                                                                                |
| `wager_transactions`    | `wager_processed_reversal_is_resolved`                                                  | a PROCESSED reversal names its reference                                                     | `rejects a PROCESSED rollback whose reference was never resolved`                                               |
| `wager_transactions`    | `wager_amount_shape` (migration 5)                                                      | amount > 0, except LOSS, which may be zero                                                   | `a zero amount is refused for every kind except LOSS`                                                           |
| `wager_transactions`    | `wager_one_processed_reversal_per_reference`                                            | one PROCESSED REFUND or ROLLBACK per reference (migration 2)                                 | `allows only one PROCESSED reversal per reference, whatever its kind`                                           |
| `wager_transactions`    | `wager_one_processed_settlement_per_reference`                                          | one PROCESSED WIN, LOSS or REFUND per BET (migration 3; migration 8 adds REFUND)             | `allows only one PROCESSED result per BET`                                                                      |
| `wallet_ledger_entries` | `ledger_seq_key`, `ledger_one_entry_per_wallet_transaction`                             | unique sequence, one entry per wallet and transaction                                        | LED-03 probe                                                                                                    |
| `wallet_ledger_entries` | `ledger_transaction_in_same_wallet_fk`                                                  | the entry's transaction is in its wallet                                                     | ledger probes                                                                                                   |
| `wallet_ledger_entries` | `ledger_wallet_currency_fk` (migration 5)                                               | the entry has its wallet's currency                                                          | `a ledger entry takes the currency of its wallet`                                                               |
| `wallet_ledger_entries` | `ledger_arithmetic`, `amount > 0`, balances `>= 0`                                      | `balance_before ± amount = balance_after`                                                    | LED-02 probe                                                                                                    |
| `wallet_ledger_entries` | triggers: no update, no delete, no truncate                                             | append-only                                                                                  | INV-06, LED-01 probes                                                                                           |
| `inbox_messages`        | primary key `(consumer_name, message_id)`                                               | one record per consumer and message                                                          | MSG-02                                                                                                          |
| `outbox_messages`       | primary key (event id), `attempts >= 0`                                                 | one row per event                                                                            | OUT-07                                                                                                          |
| `api_clients`           | `api_client_role_shape`                                                                 | PROVIDER names a provider, OPERATOR names none (migration 4)                                 | `a PROVIDER must name a provider, and an OPERATOR must not`                                                     |
| `api_clients`           | `key_hash` UNIQUE and CHECK (64 hex)                                                    | one client per key, and the stored value is a SHA-256 digest                                 | `two clients cannot share a key hash`                                                                           |
| `api_clients`           | `name` CHECK (not blank), `role` CHECK                                                  | a client has a name and a known role                                                         | integration tests and the CLI test                                                                              |

Not enforced by the database, and why:

- **The player and currency of a transaction against its wallet.** A REJECTED row keeps the player
  and currency it was submitted with (decision D6). The domain checks them, and the rejected row
  is kept.
- **The balance chain across ledger rows** (`balance_before` equals the previous `balance_after`).
  Writes produce it, and reconciliation checks it. A constraint across rows would need a trigger
  on every insert, and it would not stop a second writer from reading stale data.
- **The state machine of `wager_transactions`.** The table is updated in place, so it is not
  append-only, as the ledger is. The domain allows only the listed transitions.

## 5. Decisions

| Decision                                                                  | Where                | Status                                                                                            |
| ------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| ADR 0001: pessimistic row lock on the wallet                              | `docs/adr/0001`      | Implemented. Tested by the hot-wallet suites                                                      |
| ADR 0002: money as a decimal string, `NUMERIC(20,2)`                      | `docs/adr/0002`      | Implemented. `Money` is precision 40                                                              |
| ADR 0003: idempotency scope and payload hash                              | `docs/adr/0003`      | Implemented. Golden hash test                                                                     |
| ADR 0004: outbox with claim and lease, at-least-once                      | `docs/adr/0004`      | Implemented. Tested by the outbox and three-process suites                                        |
| ADR 0005: hold for missing references, with bounded retries               | `docs/adr/0005`      | Implemented. Six attempts; delay capped at five minutes (tested)                                  |
| ADR 0006: authentication deferred                                         | `docs/adr/0006`      | Superseded by ADR 0007                                                                            |
| ADR 0007: API keys, two roles, provider scope                             | `docs/adr/0007`      | Implemented. Decision D5 is open for the owner                                                    |
| ARCHITECTURE section 13: one reversal per reference (D4)                  | `ARCHITECTURE.md`    | Implemented. Confirmed on 2026-11-01; additional interpretation to rule 4                         |
| Section 13: WIN and LOSS may name their BET (D1)                          | `ARCHITECTURE.md`    | Implemented. Confirmed on 2026-11-01; an unreferenced WIN does not demonstrate uniqueness per BET |
| Section 13: one result per BET, REFUND only without a result (D3)         | `ARCHITECTURE.md`    | Implemented. Confirmed on 2026-11-01                                                              |
| Section 13: ROLLBACK in every state (D2)                                  | `ARCHITECTURE.md`    | Implemented. Economic effect confirmed on 2026-11-01; individual reversal, no implicit cascade    |
| Section 13: player and currency mismatch is a persisted REJECTED row (D6) | `ARCHITECTURE.md`    | Implemented                                                                                       |
| Section 13: OPENING under the internal provider id `system`               | `ARCHITECTURE.md`    | Implemented                                                                                       |
| Compose restarts api and worker (not covered by a test)                   | `docker-compose.yml` | Configuration only. Checked with `docker compose config`                                          |

## 6. Gaps that remain, and what they mean

- **An HTTP crash after commit but before the response** is covered at the process level by
  `test/concurrency/process-crash-and-shutdown.test.ts`: the new API retries the operation, and the test checks a
  replay, one debit and one event.
- **Keys do not expire or rotate**, and the API serves plain HTTP. A real deployment must add TLS
  and an identity provider (D5).
- **Queue messages are not authenticated.** The challenge treats the queue as an internal channel.
  In AWS this is an IAM policy, which this build does not configure.
- **Load is not tested.** The concurrency suites prove correctness, not throughput. _Note: this review predates the load tests; the measured throughput is in [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md)._
- **Metrics are per process**, with no aggregation.
- **Reconciliation is on demand**, with no schedule.
- **The remaining matrix labels are descriptive.** Each cites a file that exists, and the named
  tests in this document were checked by name.

### HEAD status update (2026-11-02)

This addendum does not change the historical results above. D1–D4 were confirmed in the 2026-11-01 instruction;
a ROLLBACK held before its BET and applied once the BET arrives remains covered by
`test/integration/wagering/pending-reference.test.ts`. Implementation defects F-03 and F-13 are closed with regression
tests; the audit distinguishes those fixes from contract details not stated literally in the challenge. HTTP crash
coverage after commit is in `test/concurrency/process-crash-and-shutdown.test.ts`.

## 7. How this review was checked

> **Historical record:** the counts below belong to the round when this section was written; they are not the current
> HEAD results. The latest local verification is in section 8.

- Every file path cited in `docs/` and `ARCHITECTURE.md` was checked for existence: 0 missing.
- The named tests in sections 3 and 4 were checked against the test files.
- `bun run check:all` passed on the final code before the push: 178 unit, 111 integration, 21
  concurrency and 32 e2e tests.
- Each database rule was checked with a probe that fails before its migration exists and passes
  after it (`schema-constraints.test.ts`).

## 8. Final-round local verification (2026-11-02)

Based on the checkout that started at `44a793bcb09d72620660339186a046311b4e549a`, the property
`test/integration/model/financial-reference-model.test.ts` ran 12 generated sequences (seed `20261102`) against the
use cases and real PostgreSQL, comparing status, failures, replay, balance, ledger-entry count and reconciliation.
It passed with 429 assertions. The full suite results for this round are recorded in `docs/AUDITORIA_FINAL.en.md`;
no hosted run was confirmed for this checkout.
