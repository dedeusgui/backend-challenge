# Agent entry point

Distributed Wagering Processor is a transactional wagering and wallet service.

## Read before changing

- [CLAUDE.md](CLAUDE.md): binding project rules and workflow.
- [ARCHITECTURE.md](ARCHITECTURE.md): system design and invariants.
- [Documentation conventions](docs/CONVENCOES_DOCUMENTACAO.md): language pairs and evidence rules.
- [Runbooks](docs/runbooks/): focused guidance by change type.

## Verification commands

- `bun run check:fast`: routine engineering gate.
- `bun run check:all`: full gate; requires infrastructure.
- `bun run arch:check`: module dependency boundaries.
- `bun run deadcode:check`: unused code and exports.
- `bun run agent:verify`: check:fast plus deadcode:check; exits non-zero at the first failing gate.

## Choose a runbook

- Financial rules or balances: [financial-change](docs/runbooks/financial-change.md).
- Locks, contention, or races: [concurrency-debugging](docs/runbooks/concurrency-debugging.md).
- Queues, outbox, retries, or recovery: [messaging-recovery](docs/runbooks/messaging-recovery.md).
- Schema or migration work: [database-migration](docs/runbooks/database-migration.md).
- Review and evidence reporting: [code-review-verification](docs/runbooks/code-review-verification.md).

The code-review runbook defines the [Evidence Contract](docs/runbooks/code-review-verification.md#evidence-contract).
