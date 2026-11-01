# Concurrency debugging

Português: [Depuração de concorrência](concurrency-debugging.md).

## Context

Use this guide for contention, deadlocks, duplicate work under races, lock timeouts, or balance/ledger divergence.

## Commands

- `bun run test:concurrency` runs concurrency proofs.
- `bun run test:integration` covers locks, timeouts, and persistence.
- `bun run test:unit` runs the unit suite.
- `bun run check:fast` checks types, lint, formatting, unit tests, and architecture.

## Invariants and evidence

- Financial work uses a transaction and lock/statement limits: `src/shared/infrastructure/database/mikro-orm-financial-unit-of-work.ts`; [timeout test](../../test/integration/wagering/lock-timeout.test.ts).
- Balance serialization must prevent negative balances and preserve ledger equality: `src/modules/wallet/domain/wallet.ts`; [hot-wallet test](../../test/concurrency/hot-wallet.test.ts).
- A conflict retry must observe the winner and must not apply an operation twice: `src/modules/wagering/application/process-wager-transaction.use-case.ts`; [idempotency and race test](../../test/integration/wagering/process-wager-transaction.test.ts).
- The pessimistic lock strategy is recorded in [ADR 0001](../adr/0001-pessimistic-wallet-lock.en.md); its concurrency proof is [hot-wallet](../../test/concurrency/hot-wallet.test.ts).

## Completion

Reproduce the race with a deterministic test, inspect both results and persisted state, and run the concurrency suite. Finish only when the test first fails for the expected reason and ledger equality and absence of duplicate work are demonstrated.
