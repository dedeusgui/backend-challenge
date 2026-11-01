# Architecture decision records

> English reference copy. The main version, in Portuguese, is [README.md](README.md).

Each record gives the context, the decision, the alternatives and the consequences.
[ARCHITECTURE.md](../../ARCHITECTURE.en.md) states the main decisions in one table and links here for the
reasoning.

| Record                                                | Decision                                                                | Status             |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ------------------ |
| [0001](0001-pessimistic-wallet-lock.en.md)            | Pessimistic row lock on the wallet, with the version as a guard         | accepted           |
| [0002](0002-money-representation.en.md)               | Money as a decimal string, decimal.js arithmetic, NUMERIC(20,2) storage | accepted           |
| [0003](0003-idempotency-scope-and-payload-hash.en.md) | Idempotency scope per provider, and the canonical payload hash          | accepted           |
| [0004](0004-outbox-claim-lease-at-least-once.en.md)   | Outbox with claim and lease, at-least-once delivery                     | accepted           |
| [0005](0005-reference-hold-and-bounded-retries.en.md) | Hold transactions for missing references, with bounded retries          | accepted           |
| [0006](0006-authentication-deferred.en.md)            | Authentication deferred, with an explicit extension point               | superseded by 0007 |
| [0007](0007-api-key-authentication.en.md)             | API keys with two roles, and provider scope                             | accepted           |
