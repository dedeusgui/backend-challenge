# Module boundaries

The folders below are intentional seams, not implemented features.

- **wallet** owns Wallet, Money-facing operations, the immutable wallet ledger and reconciliation. HTTP endpoints live in `http`; persistence adapters in `infrastructure`.
- **wagering** owns the WagerTransaction lifecycle and the central ProcessWagerTransaction use case. HTTP and SQS must invoke this same application use case.
- **messaging** owns Inbox deduplication, transactional Outbox records and SQS adapters. It does not decide whether a BET or REFUND is valid.
- **shared** is reserved for genuinely cross-module concepts (e.g. the immutable Money value object, database transaction boundary and provider identity port), never a general-purpose dumping ground.

Use cases coordinate; domain objects enforce invariants; repositories map data and participate in a caller-owned transaction. Keep NestJS, MikroORM and AWS imports outside `domain`.
