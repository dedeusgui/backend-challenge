_The main document is in Portuguese: [COESAO.en.md](COESAO.en.md)._

# Cohesion analysis based on change history

## 1. Question and short answer

**Project owner question:** There are 2-line files next to 600-line files. What is their cohesion, and what can we do to make the code more cohesive?

**Conclusion:**
Cohesion here assesses whether the elements of a file change together for the same reason and whether small files delineate genuine architectural boundaries. Small files (2 to 9 lines) are application ports, injection tokens, and shared domain contracts that isolate responsibilities and must remain separate. Excessive length is concentrated in 24 files with more than 300 lines (22 of which are tests and load tooling), of which 4 suites mix independent responsibilities and must be divided.

## 2. How it was measured

All commands were executed from the repository root on the HEAD commit.

### Line counts and size ranges

Line count across all tracked files in `src/` and `test/`:

```bash
git ls-files src test | xargs wc -l
```

Total output: 33,111 lines across 277 tracked files.

Distribution by size tiers (all tracked files):

- Files with up to 10 lines:

```bash
git ls-files src test | xargs wc -l | awk '$1 <= 10 && $2 != "total"'
```

Output: 21 files (5 TypeScript files, 1 Markdown documentation file, and 15 `.gitkeep` files with 0 lines).

- Files with 11 to 50 lines:

```bash
git ls-files src test | xargs wc -l | awk '$1 >= 11 && $1 <= 50 && $2 != "total"'
```

Output: 81 files.

- Files with more than 300 lines:

```bash
git ls-files src test | xargs wc -l | awk '$1 > 300 && $2 != "total"'
```

Output: 24 files.

Distribution restricted to TypeScript code (`.ts`):

- Total `.ts` files:

```bash
git ls-files src test | grep '\.ts$' | wc -l
```

Output: 256 files.

- `.ts` files with up to 10 lines:

```bash
git ls-files src test | grep '\.ts$' | xargs wc -l | awk '$1 <= 10 && $2 != "total"'
```

Output: 5 files.

- `.ts` files with 11 to 50 lines:

```bash
git ls-files src test | grep '\.ts$' | xargs wc -l | awk '$1 >= 11 && $1 <= 50 && $2 != "total"'
```

Output: 79 files.

- `.ts` files with more than 300 lines:

```bash
git ls-files src test | grep '\.ts$' | xargs wc -l | awk '$1 > 300 && $2 != "total"'
```

Output: 24 files (2 in `src/` and 22 in `test/`).

### Git co-change history

Command to extract commits on HEAD:

```bash
git log --no-merges --name-only --format='@@%h|%s'
```

Filtering rules:

- Exclude merge commits (`--no-merges`).
- Exclude commits whose subject begins with `docs` or whose modified files belong exclusively to `docs/` and `package.json`.
- Evaluated set: 113 commits with modifications in `src/` and `test/` files.
- For each pair of files touched in the same commit, the co-change count is incremented. Pairs with 3 or more joint commits were inspected for cross-module coupling.

## 3. Table of small files (up to 10 lines)

| File                                                           | Lines | Strongest partner                                               | Co-changes   | Recommendation                                                                                                              |
| :------------------------------------------------------------- | :---- | :-------------------------------------------------------------- | :----------- | :-------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/infrastructure/sqs/sqs.tokens.ts`                  | 2     | `src/app.module.ts`                                             | 1 (isolated) | KEEP SEPARATE: Nest composition point for SQS client dependency injection tokens without exposing concrete implementations. |
| `src/shared/domain/ledger-direction.ts`                        | 3     | `src/modules/wagering/domain/failure-code.ts`                   | 2 (isolated) | KEEP SEPARATE: Domain contract shared between modules to prevent direct coupling between wallet and wagering.               |
| `src/modules/messaging/application/ports/inbox-repository.ts`  | 6     | `src/modules/auth/application/authenticate-api-key.use-case.ts` | 1 (isolated) | KEEP SEPARATE: Hexagonal port decoupling the application layer from message deduplication infrastructure.                   |
| `src/shared/application/ports/database-clock.ts`               | 8     | `src/modules/auth/application/authenticate-api-key.use-case.ts` | 1 (isolated) | KEEP SEPARATE: Application port abstracting database transaction clock reads without persistence driver dependency.         |
| `src/modules/messaging/application/ports/outbox-repository.ts` | 9     | `src/modules/auth/application/authenticate-api-key.use-case.ts` | 1 (isolated) | KEEP SEPARATE: Hexagonal port for transactional outbox integration event enqueueing within the unit of work.                |

_Note:_ `src/modules/README.md` (10 lines) is explanatory architecture documentation and the 15 `.gitkeep` files (0 lines) are git directory markers, all kept separate.

## 4. Table of large files (more than 300 lines)

| File                                                                     | Lines | Reasons for change                                                                            | Recommendation                                                                                                                             |
| :----------------------------------------------------------------------- | :---- | :-------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `test/load/load-test.ts`                                                 | 951   | Load test orchestration, CPU affinity pinning via cpuset/taskset, and latency measurement.    | KEEP: Single load orchestration script.                                                                                                    |
| `test/integration/wagering/process-wager-transaction.test.ts`            | 926   | Integration validation of the wager processing use case against real PostgreSQL.              | KEEP: Cohesive suite mirroring the core use case.                                                                                          |
| `test/integration/schema/schema-constraints.test.ts`                     | 840   | Three independent domains: wallet, wagering, and messaging database constraints.              | DIVIDE: Split into `wallet-schema-constraints.test.ts`, `wagering-schema-constraints.test.ts`, and `messaging-schema-constraints.test.ts`. |
| `test/features/steps/mensageria.steps.ts`                                | 670   | Two distinct subjects: SQS/DLQ queue consumption and asynchronous reference resolution.       | DIVIDE: Split into `mensageria-consumer.steps.ts` and `reference-worker.steps.ts`.                                                         |
| `test/features/steps/finance-edge.steps.ts`                              | 644   | Four subjects: monetary types, numeric overflow, reversal concurrency, and database triggers. | DIVIDE: Split into `money.steps.ts`, `settlement-edge.steps.ts`, and `row-guards.steps.ts`.                                                |
| `test/concurrency/distributed-contention.test.ts`                        | 541   | Distributed balance contention scenarios between concurrent processes.                        | KEEP: Dedicated focus on real concurrency verification.                                                                                    |
| `test/integration/messaging/outbox-publisher.test.ts`                    | 505   | Batch publication lifecycle and lease management on the outbox.                               | KEEP: Dedicated suite for the transactional publisher.                                                                                     |
| `test/unit/wagering/domain/wager-transaction.test.ts`                    | 502   | State transition rules and validation of the wager transaction aggregate.                     | KEEP: Cohesive unit suite aligned with the domain entity.                                                                                  |
| `test/load/report.ts`                                                    | 491   | Two responsibilities: Markdown report formatting and filesystem I/O for JSON run records.     | DIVIDE: Split into `test/load/report-renderer.ts` and `test/load/run-store.ts`.                                                            |
| `src/modules/wagering/domain/wager-transaction.ts`                       | 397   | Lifecycle invariants and business rules of the wager transaction aggregate.                   | KEEP: Aggregate root with high internal cohesion; methods operate strictly on entity state.                                                |
| `test/integration/model/random-sequences.test.ts`                        | 394   | Property-based testing with pseudorandom operation sequences.                                 | KEEP: Single-purpose model test generator.                                                                                                 |
| `test/features/steps/mensageria-outbox.steps.ts`                         | 392   | Gherkin step definitions for the outbox publication lifecycle.                                | KEEP: Dedicated focus on outbox behavior.                                                                                                  |
| `test/integration/messaging/wager-command-consumer.test.ts`              | 391   | Integration tests for the SQS command consumer.                                               | KEEP: Dedicated consumer test suite.                                                                                                       |
| `test/integration/faults/fault-injection.test.ts`                        | 368   | Controlled fault injection and transactional recovery.                                        | KEEP: Specialized resilience suite.                                                                                                        |
| `test/integration/wagering/pending-reference.test.ts`                    | 361   | Retention and reprocessing lifecycle for transactions awaiting external references.           | KEEP: Dedicated suite for the unresolved reference flow.                                                                                   |
| `test/e2e/authorization-adversarial.test.ts`                             | 350   | Adversarial attack and HTTP authorization compliance scenarios with API keys.                 | KEEP: Single-focus security test suite.                                                                                                    |
| `test/integration/messaging/duplicate-deliveries.test.ts`                | 341   | Idempotency and tolerance to duplicate messaging deliveries.                                  | KEEP: Dedicated delivery guarantees suite.                                                                                                 |
| `test/edge/protected-mode.test.ts`                                       | 325   | Rate limit and header rules on the Nginx edge proxy.                                          | KEEP: Dedicated edge suite.                                                                                                                |
| `test/e2e/openapi-responses.test.ts`                                     | 325   | Contract and response compliance against OpenAPI specification.                               | KEEP: Contract API validation suite.                                                                                                       |
| `src/modules/wagering/application/process-wager-transaction.use-case.ts` | 324   | Wager processing use case orchestration (idempotency, wallet lock, and settlement).           | KEEP: Single execution flow; private methods serve strictly the processing pipeline.                                                       |
| `test/e2e/input-contract-http.test.ts`                                   | 323   | Input validation and rejection of malformed HTTP payloads.                                    | KEEP: Dedicated input contract suite.                                                                                                      |
| `test/integration/schema/row-guards.test.ts`                             | 320   | PostgreSQL trigger validation for integrity and immutability of ledger entries.               | KEEP: Specialized database integrity suite.                                                                                                |
| `test/concurrency/three-processes.test.ts`                               | 307   | Financial balance integrity under contention across three parallel processes.                 | KEEP: Distributed contention suite.                                                                                                        |
| `test/load/workload.ts`                                                  | 303   | Synthetic transaction mix generation for load testing.                                        | KEEP: Cohesive load generation module.                                                                                                     |

## 5. Cross-module pairs with coupling (bad sign)

| File pair                                                                                                                                               | Co-changes | Evidence interpretation                                                                                                                                                                 |
| :------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/wagering/http/wagering.controller.ts` <br> `src/modules/wallet/http/wallet.controller.ts`                                                  | 4          | Separate business controllers modified simultaneously to introduce API key authentication and standardize 400 errors. Reflects scattered HTTP evolutions prior to unified interceptors. |
| `src/modules/wagering/http/wagering.controller.ts` <br> `src/shared/http/error-response.ts`                                                             | 4          | Wagering controller adjusted repeatedly with each update to shared HTTP error structures and codes.                                                                                     |
| `src/modules/wallet/http/wallet.controller.ts` <br> `src/shared/http/error-response.ts`                                                                 | 3          | Same coupling observed on the wagering controller, caused by synchronous evolution of HTTP error formatting.                                                                            |
| `src/app.module.ts` <br> `src/modules/wagering/http/wagering.controller.ts`                                                                             | 4          | Central composition inside Nest root module, requiring edits for each new route or controller dependency.                                                                               |
| `src/modules/messaging/infrastructure/mikro-orm-inbox.repository.ts` <br> `src/modules/wagering/application/process-wager-transaction.use-case.ts`      | 3          | Wagering use case directly coordinates inbox table deduplication persistence inside the financial unit of work.                                                                         |
| `src/modules/wagering/infrastructure/mikro-orm-wager-transaction.repository.ts` <br> `src/modules/wallet/infrastructure/mikro-orm-wallet.repository.ts` | 3          | Distinct domain repositories evolved together during pessimistic locking and concurrency adjustments within the shared unit of work.                                                    |
| `src/worker/worker-runtime.ts` <br> `src/modules/wagering/application/process-wager-transaction.use-case.ts`                                            | 3          | Worker entry point adjusted alongside use case orchestration for non-HTTP background execution.                                                                                         |
| `test/integration/schema/schema-constraints.test.ts` <br> `src/modules/wagering/domain/wager-transaction.ts`                                            | 3          | Monolithic schema suite accumulating rules from multiple table domains, breaking modular test isolation.                                                                                |
| `test/integration/faults/fault-injection.test.ts` <br> `test/integration/messaging/outbox-publisher.test.ts`                                            | 5          | Infrastructure test suites coupled by simultaneous updates to fault hooks and outbox lease timing.                                                                                      |

## 6. What was not verified: limitations of the method

- **Short history:** The repository contains 175 total commits (113 evaluated after excluding docs and merges). Small files were introduced during modular restructuring milestones and accumulated few commits, leading to an 'isolated' tag due to temporal rarity rather than disuse.
- **Vertical slice commits:** Delivering complete increments in a single commit groups code, tests, and documentation. This creates temporal co-changes between files in different modules without direct runtime code dependencies between them.
- **Static import coupling:** Git co-change reflects only commit co-occurrence. Static dependency graphs are verified separately through architectural boundary tests in [boundaries.test.ts](../test/unit/architecture/boundaries.test.ts).
- **Batch structural refactorings:** Folder restructuring commits modified dozens of files in a single commit, producing transient co-change counts that do not represent continuous logical coupling.
