# Database migration

Português: [Migração de banco de dados](database-migration.md).

## Context

Use this guide when changing migrations, persisted entities, constraints, indexes, triggers, or schema-derived data.

## Commands

- `bun run db:migrate` applies migrations through the project entry point.
- `bun run test:integration` includes schema and migration validation.
- `bun run check:fast` covers fast checks and architecture.
- `bun run check:all` is the full gate and depends on infrastructure.

## Invariants and evidence

- Migrations are versioned, and reapplying after rollback restores the same schema: `src/shared/infrastructure/database/migrations/`; [test](../../test/integration/schema/migrations.test.ts).
- Materialized balance equals the ledger sum and cannot become negative: [trigger test](../../test/integration/schema/ledger-balance-trigger.test.ts); [concurrency test](../../test/concurrency/hot-wallet.test.ts).
- Wallet and wager constraints reject invalid states: [wallet](../../test/integration/schema/wallet-schema-constraints.test.ts) and [wagering](../../test/integration/schema/wagering-schema-constraints.test.ts).
- Messaging tables preserve identity and uniqueness: [constraints test](../../test/integration/schema/messaging-schema-constraints.test.ts).
- ORM configuration defines the migration location: `src/shared/infrastructure/database/orm-config.ts`; rollback and reapplication are proven in [migrations.test.ts](../../test/integration/schema/migrations.test.ts).

## Completion

Review generated SQL and upgrade and rollback effects. Confirm migrations can be reapplied, relevant constraints are tested, and all derived data stays consistent; run the full gate before completion.
