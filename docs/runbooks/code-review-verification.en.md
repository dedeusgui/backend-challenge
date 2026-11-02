# Code review and verification

Português: [Revisão e verificação](code-review-verification.en.md).

## Context

Use this guide to review a change, prepare its completion report, or record verifiable evidence. For a specialist change, also open the relevant finance, concurrency, messaging, or database guide.

## Commands

- `bun run check:fast` runs types, lint, formatting, unit tests, and architecture checks.
- `bun run arch:check` checks module dependencies.
- `bun run deadcode:check` looks for unused code.
- `bun run check:all` is the final gate and requires infrastructure.
- `bun run agent:verify` runs `check:fast` and `deadcode:check`. Financial, persistence, or infrastructure changes also require `bun run check:all`.

## Invariants and evidence

- Binding architecture and rules live in [CLAUDE.md](../../CLAUDE.md) and [ARCHITECTURE.en.md](../../ARCHITECTURE.en.md); do not duplicate them here.
- Documentation conventions require verifiable paths and commands: [CONVENCOES_DOCUMENTACAO.en.md](../CONVENCOES_DOCUMENTACAO.en.md).
- Fast and full gates are defined in `package.json`; suites are under `test/unit/` and `test/integration/`.
- A suite that was not run does not prove behavior; the requirements matrix is [REQUIREMENTS_MATRIX.en.md](../REQUIREMENTS_MATRIX.en.md).

## Work coordination

Use isolated worktrees per task and explicit file scope; workers must not edit the same file in parallel. Financial changes need independent review before merge. Validated behavior beats a persuasive explanation.

## Evidence Contract

The completion report has exactly these fields: **What changed; Why; Failing test before the change (if applicable); Tests run (command and result); Risks; Commit; Limitations.**

A claim of success requires the executed command and its observed output. Record actual results, including failures or limitations; static analysis or intent is not an executed test.

## Completion

Review the diff and scope, verify paths and documentation pairs, and record the complete report. Mark the work complete only with reproducible evidence, explicit risks and limitations, and the commit SHA.
