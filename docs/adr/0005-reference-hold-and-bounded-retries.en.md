# ADR 0005: Hold transactions for missing references, with bounded retries

> English reference copy. The main version, in Portuguese, is [0005-reference-hold-and-bounded-retries.md](0005-reference-hold-and-bounded-retries.md).

**Status:** accepted

## Context

Providers can send a REFUND or ROLLBACK before the BET it reverses (challenge
§7.1). Such a transaction must neither be lost nor applied before its reference.

## Decision

- A transaction whose reference is missing is stored as `PENDING_REFERENCE`, with
  its attempt count and next lookup time in the row. A `WagerTransactionPendingReference`
  event is written.
- `ProcessPendingReferences` (in the worker) resolves each due row under the
  **wallet lock**, and re-reads it there. Two workers therefore never apply the same
  row. The decision is the same `TransactionSettlement` the HTTP path uses.
- Retries back off from 1 s, doubling, capped at 5 minutes. The limit is six misses
  (`MAX_REFERENCE_ATTEMPTS`). After that the row is `REJECTED` with
  `REFERENCE_NOT_FOUND`, and the rejection is announced.
- A reference that is itself still pending makes the dependent row wait. A reference
  that was rejected makes it `REFERENCE_NOT_PROCESSED`.

## Alternatives

- **Reject immediately.** Loses valid reversals that only arrive out of order.
- **Unbounded retries.** A reference that never arrives would be retried forever,
  with no audit outcome.
- **A separate queue for holds.** More infrastructure, and the schedule would live
  outside the transaction it belongs to.

## Consequences

- A held transaction is not visible as applied, and its balance is not changed.
  Its status states why.
- The schedule is in PostgreSQL, so a restarted worker resumes it (`REF-04`).

## Evidence

- `test/integration/wagering/pending-reference.test.ts`: applied once the reference
  arrives, backoff respected, exhaustion to REFERENCE_NOT_FOUND, continuation after
  a restart, and six workers racing over six refunds of one wallet.
- `test/integration/faults/fault-injection.test.ts`: a crash while resolving rolls
  back, and the next pass applies the refund exactly once.
