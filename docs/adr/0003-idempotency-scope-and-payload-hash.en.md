# ADR 0003: Idempotency scope and canonical payload hash

> English reference copy. The main version, in Portuguese, is [0003-idempotency-scope-and-payload-hash.md](0003-idempotency-scope-and-payload-hash.md).

**Status:** accepted

## Context

The `Idempotency-Key` header is the source of truth (challenge §10). A repeated
request must replay the original result, including the balance seen then. The same
key with a different payload is a conflict, not a replay.

## Decision

- Uniqueness is per provider: `UNIQUE(provider_id, idempotency_key)` and
  `UNIQUE(provider_id, external_transaction_id)` in `wager_transactions`.
- A request is a replay when its **business payload** hash matches a stored
  transaction found by key or by external id. The payload is `providerId`,
  `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
  `money` and the reference. The key and transport metadata are excluded.
- The hash is SHA-256 over canonical JSON: keys sorted at every level, no
  whitespace, an absent reference as `null`. A golden test fixes the exact string.
- The result, including `result_balance`, is stored on the row, so a replay returns
  the balance observed at the time, even after later operations.

## Alternatives

- **Global key scope.** Two providers could collide on a key they do not control.
  Per-provider scope avoids that, and the provider is part of every lookup anyway.
- **Hashing the whole request body.** Would include transport fields and make a
  harmless reordering a conflict.
- **In-memory cache.** Forbidden (challenge §5.2), and wrong across instances.

## Consequences

- A same external id under another key with the same payload replays. Under a
  different payload it conflicts. Both are covered by tests.
- Changing the canonical form invalidates stored hashes. The golden test is the
  guard against an accidental change.

## Evidence

- `test/unit/wagering/domain/wager-payload-hash.test.ts` (golden string and
  sensitivity per field).
- `test/integration/wagering/process-wager-transaction.test.ts`: replay with the
  original balance, conflict, and cross-key external-id cases.
- `test/concurrency/three-processes.test.ts`: 50 identical requests over three
  processes produce one debit and one transaction id.
