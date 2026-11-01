# Financial change

Português: [Mudança financeira](financial-change.md).

## Context

Use this guide when changing balances, ledger entries, BET/WIN/LOSS/REFUND/ROLLBACK rules, idempotency, or settlement.
Read [CLAUDE.md](../../CLAUDE.md) and [Architecture](../../ARCHITECTURE.en.md) before changing financial code.

## Commands

- `bun run test:unit` runs unit tests; `bun run test:integration` covers financial persistence.
- `bun run test:concurrency` covers cross-process races.
- `bun run check:fast` is the fast verification; financial changes require the full `bun run check:all` gate.
- `bun run arch:check` checks module boundaries.

## Invariants and evidence

- Money uses exact decimals, never `number`: `src/shared/domain/money.ts`; [test](../../test/unit/shared/domain/money.test.ts).
- A balance cannot become negative and must equal the ledger sum: `src/modules/wallet/domain/wallet.ts`; [concurrency test](../../test/concurrency/hot-wallet.test.ts).
- Settlement rules stay in one service shared by HTTP and reference flows: `src/modules/wagering/application/transaction-settlement.ts`; [test](../../test/integration/wagering/process-wager-transaction.test.ts).
- Financial persistence runs in one unit-of-work transaction: `src/shared/infrastructure/database/mikro-orm-financial-unit-of-work.ts`; [crash and rollback test](../../test/integration/faults/fault-injection.test.ts).
- A reference can only be reversed or settled according to its lifecycle: `src/modules/wagering/domain/wager-transaction.ts`; [settlement test](../../test/integration/wagering/process-wager-transaction.test.ts).

## Completion

Document the test that failed before the change, run relevant suites, and record command and result in the [Evidence Contract](code-review-verification.en.md#evidence-contract). Financial changes need independent review before merge. Complete only when the financial rules and persisted ledger agree and the applicable gate passes.
