# Agent instructions

Distributed Wagering Processor. Read `ARCHITECTURE.md` before changing financial code, and
`docs/REQUIREMENTS_MATRIX.md` to see which requirement a change affects.

## Commands

- `bun run check:fast`: typecheck, lint, format and unit tests. Run it after each change.
- `bun run check:all`: the final gate. It needs `bun run infra:up` (PostgreSQL and LocalStack).
- Run one suite with `bun test <path>`. Bun reads `bunfig.toml`, so paths are relative to the repo.

## Boundaries

- `domain` imports nothing from NestJS, MikroORM or AWS.
- A use case coordinates. It does not hold business rules that a domain object can hold.
- Financial decisions live in `TransactionSettlement` and the entities. HTTP, SQS and workers
  call them. Nobody reimplements a rule in a controller or a consumer.
- Controllers parse input and present output. They never open a transaction.
- Money is `Money` (a decimal string, never a `number`). Amounts are never logged.
- Persist with the unit of work. Never write outside `FinancialUnitOfWork` in financial code.
- Fault hooks are test-only. Production code carries none.

## Quality bar

- Write the failing test first, then the minimal code, then refactor. Watch each test fail for
  the expected reason.
- Never weaken an assertion to make a test pass. Fix the code, or fix a test that states the
  wrong behaviour, and say which.
- No `any`, no `!` non-null assertions, no `as` casts to hide a type. Narrow `unknown` instead.
- No test that asserts nothing, no `test.only`, no skipped tests.
- A requirement is `PASSING` in the matrix only after its suite has run and passed.

## Workflow

- Work in vertical slices. Each slice ends with `check:all` passing, a matrix update and one
  Conventional Commit.
- Commit messages: Conventional Commits, for example `feat(wagering): ...`, `test(concurrency): ...`.
- Do not rewrite history that has been pushed. Amending your own unpushed commit is fine.
- Never commit `.env`, credentials or generated snapshots.

## Known constraints

- The sandbox TLS proxy blocks package downloads during a Docker build. Verify the image with
  a scratch context and the sandbox CA, outside the repository (see `ARCHITECTURE.md` section 14).
- MikroORM is pinned to 7.x. Use `defineEntity` (not decorators) and `migrator.up()`.
- LocalStack returns queue URLs under a host name that may not resolve. Build queue URLs from
  the configured endpoint when one is set.
