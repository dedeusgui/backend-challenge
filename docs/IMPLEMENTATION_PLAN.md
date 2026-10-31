# Implementation plan / acceptance checklist

This is an engineering checklist, not a statement of completed functionality.
The [challenge specification](CHALLENGE.md) is authoritative.

## Slice 0 — Foundation

- [x] Bun/NestJS bootstrap with strict TypeScript and a liveness endpoint
- [x] Local PostgreSQL, LocalStack and SQS queues in Docker Compose
- [x] Vertical module layout and documented architectural decisions
- [x] Generate and commit `bun.lock` with Bun 1.4.4 (pinned in CI and Dockerfile)
- [x] Run `bun run typecheck`, tests and Compose locally; fix actual failures
  - Audit findings fixed: Dockerfile installed without lockfile and used a
    floating `oven/bun:1`; CI used floating `bun-version: 1.x`; `format:check`
    failed on 5 files; LocalStack image was a floating major tag.
  - Verified: `docker compose up postgres localstack` provisions the FIFO
    queues and redrive policy; the API image builds with `--frozen-lockfile`
    and serves `/health/live`.

## Slice 1 — Domain (unit tests first)

- [ ] Money: immutability, exact 2-decimal strings, currency mismatch
- [ ] Wallet: factory/rehydrate, debit/credit, no negative balance
- [ ] WagerTransaction: all kinds/statuses, references and terminal states
- [ ] WalletLedgerEntry: strict balanced-entry validation and immutability
- [ ] Inbox and Outbox entities and typed versioned integration event classes

## Slice 2 — Storage and atomic use cases

- [ ] MikroORM config and versioned migrations with explicit `down`
- [ ] Unique constraints, nonnegative balance CHECK, immutable ledger trigger
- [ ] Transaction boundaries + ORM mapping to/from domain factories
- [ ] Wallet opening with internal OPENING + ledger in same transaction
- [ ] ProcessWagerTransaction (BET/WIN/LOSS/REFUND/ROLLBACK)
- [ ] Consistent HTTP error taxonomy + original result on idempotent replay
- [ ] GET wallet, cursor ledger, transaction lookups and reconciliation

## Slice 3 — Messaging and recovery

- [ ] SQS consumer invokes the same use case and uses persistent Inbox
- [ ] ACK only after commit; retry, classification, visibility and DLQ
- [ ] Outbox messages written atomically; concurrent publisher claim/lease
- [ ] Reference worker with bounded attempts/backoff
- [ ] Graceful SIGTERM behavior and crash recovery

## Slice 4 — Required integration proof

- [ ] Migrations and PostgreSQL schema constraints tested on fresh DB
- [ ] Same BET sent 50 times concurrently: one financial effect
- [ ] Two BETs of 80.00 against 100.00: one accepted, final 20.00
- [ ] Two independent wallets progress simultaneously
- [ ] At least three independent Bun/Nest processes against shared DB/queues
- [ ] Redelivery after commit-before-ACK does not reapply transaction
- [ ] Two Outbox publishers remain safe under concurrent claim/retry
- [ ] REFUND/ROLLBACK before reference recovers and applies once
- [ ] Restart preserves balance and ledger equality
- [ ] Readiness probes actual Postgres and SQS; structured logs and metrics

## Final submission

- [ ] `docker compose up --build` and migrations run from a clean checkout
- [ ] Typecheck, formatter and test suite pass; no hidden external services
- [ ] Update README/ARCHITECTURE with validated behavior and real limitations
- [ ] No secret or machine-specific configuration committed
- [ ] Publish link through the recruiter-provided submission form
