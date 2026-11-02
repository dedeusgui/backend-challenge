# Documentation index

English reference copy. The main version, in Portuguese, is [README.md](README.md).

This is the central documentation hub for the **Distributed Wagering Processor**. The documents are in Portuguese
(pt-BR). File names, commands, identifiers, JSON fields, and code snippets remain as they are in the code.

To verify the solution in about 40 minutes, start with the [README](../README.en.md) and follow the
[reviewer guide](REVIEWER_GUIDE.en.md) ([Portuguese](REVIEWER_GUIDE.en.md)).

## Reading order

1. [README](../README.en.md): how to run the stack, demo, and test suites.
2. [Reviewer guide](REVIEWER_GUIDE.en.md): verification walkthrough, including what each test proves and does not prove; [Portuguese](REVIEWER_GUIDE.en.md).
3. [Requirements matrix](REQUIREMENTS_MATRIX.en.md): each requirement linked to the test that proves it.
4. [Architecture](../ARCHITECTURE.en.md): main flows and decisions, with the decision table at the beginning.
5. [Domain glossary](DOMAIN_GLOSSARY.md): domain terms and their names in code.
6. [HTTP contract](openapi.json): the OpenAPI contract, checked against the real routes.
7. [Security automation](SECURITY_AUTOMATION.en.md): configured workflows and limits of the available evidence.

## Reviewer questions

Use this table when you already know what you are looking for. Each answer points to a single place.

| Question                                                                | Where to find the answer                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How do I run the solution and the demo?                                 | [README](../README.en.md), "How to run" section                                                                                                                                           |
| What commands are available, and what does each do?                     | [README](../README.en.md), "Tests" and "Other commands" sections                                                                                                                          |
| Are PostgreSQL and SQS real, or are they just mocks?                    | [Test strategy](TEST_STRATEGY.en.md), "Suites and commands" section                                                                                                                       |
| What are the decisions, trade-offs, and limitations?                    | [Architecture](../ARCHITECTURE.en.md), "Main decisions" table and sections 13 and 14                                                                                                      |
| Where is idempotency implemented?                                       | [Architecture](../ARCHITECTURE.en.md), section 6                                                                                                                                          |
| How does the balance remain non-negative under concurrency?             | [Architecture](../ARCHITECTURE.en.md), section 5                                                                                                                                          |
| How is the event published only after commit?                           | [Architecture](../ARCHITECTURE.en.md), section 8                                                                                                                                          |
| How are out-of-order references handled, and what is the limit?         | [Architecture](../ARCHITECTURE.en.md), section 9                                                                                                                                          |
| What are the disqualifying failures, and where is the proof for each?   | [Requirements matrix](REQUIREMENTS_MATRIX.en.md), disqualifying section (§14)                                                                                                             |
| What is the HTTP contract?                                              | [OpenAPI](openapi.json) and [Architecture](../ARCHITECTURE.en.md), section 10                                                                                                             |
| What capacity was measured, and with what caveats?                      | [README](../README.en.md), "Performance evidence" section. Details: cloud [baseline](LOAD_TEST_RESULTS.md) (in English) and [local baseline](LOAD_TEST_BASELINE.en.md), with 13 scenarios |
| What are the two load baselines, and in which environment did each run? | [README](../README.en.md), "Two baselines, two environments"; and [local baseline](LOAD_TEST_BASELINE.en.md), "Two baselines, two environments" section                                   |
| Which contract question can only the brief's owner clarify?             | [Final audit, §12](AUDITORIA_FINAL.en.md); D1–D4 are confirmed, and only additional contract questions depend on Jungle Gaming.                                                           |

**Main reading:** README, Architecture, Reviewer guide, requirements matrix, decisions/ADRs, and test strategy.
Audits, extensive matrices, benchmarks, mutation experiments, histories, public comparisons, security reports, and
observability documentation are reference material for specific questions.

**English versions:** each main document has an English reference copy, with the `.en.md` suffix, such as
[README.en.en.md](../README.en.md) and [ARCHITECTURE.en.en.md](../ARCHITECTURE.en.md). The content is the same.

## Documentation divisions

### Main documentation

Recommended reading to understand and evaluate the system:

- [README](../README.en.md): execution, demo, and commands.
- [ARCHITECTURE](../ARCHITECTURE.en.md): design, central decisions, and limits.
- [REVIEWER_GUIDE](REVIEWER_GUIDE.en.md) ([Portuguese](REVIEWER_GUIDE.en.md)): verification walkthrough.
- [REQUIREMENTS_MATRIX](REQUIREMENTS_MATRIX.en.md): requirements and evidence.
- [DECISIONS](../DECISIONS.en.md) and [ADRs](adr/README.en.md): consolidated decisions and their records.
- [TEST_STRATEGY](TEST_STRATEGY.en.md): scope and limits of the suites.

### Reference documentation

Use according to the question: audits ([AUDITORIA_FINAL](AUDITORIA_FINAL.en.md),
[INVARIANT_REVIEW](INVARIANT_REVIEW.en.md), [audit index](audit/README.md)), extensive matrices ([FLOW_MATRIX](FLOW_MATRIX.en.md),
matrices in `audit/`), benchmarks ([LOAD_TEST_RESULTS](LOAD_TEST_RESULTS.md), [local baseline](LOAD_TEST_BASELINE.en.md),
[public comparison](audit/PERFORMANCE_COMPARISON.md)), mutation experiments ([TEST_STRATEGY](TEST_STRATEGY.en.md)),
histories ([LOAD_TEST_HISTORY](LOAD_TEST_HISTORY.en.md), [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.en.md)), security reports
([SECURITY_AUTOMATION](SECURITY_AUTOMATION.en.md)), and observability (metrics and health described in
[ARCHITECTURE](../ARCHITECTURE.en.md)).

## Documents by topic

| Topic               | Document                                                                                                                                                                                                                                              | Contents                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Entry               | [README](../README.en.md)                                                                                                                                                                                                                             | Overview, how to run, test, and demo                                                 |
| Brief               | [Challenge](CHALLENGE.md)                                                                                                                                                                                                                             | Original challenge brief, faithful copy                                              |
| Glossary            | [Domain glossary](DOMAIN_GLOSSARY.md)                                                                                                                                                                                                                 | Domain terms and their names in code                                                 |
| Architecture        | [Architecture](../ARCHITECTURE.en.md)                                                                                                                                                                                                                 | Flows, main decisions, and limitations (section 14)                                  |
| Decisions           | [Decisions](../DECISIONS.en.md)                                                                                                                                                                                                                       | Index of the 141 decisions, grouped by topic, with evidence for each group           |
| Decision records    | [ADRs](adr/README.en.md)                                                                                                                                                                                                                              | ADRs 0001 to 0007, with context, alternatives, and consequences                      |
| Requirements        | [Requirements matrix](REQUIREMENTS_MATRIX.en.md)                                                                                                                                                                                                      | Requirement, test that proves it, and status (`PASSING` only after the suite passes) |
| Test strategy       | [Test strategy](TEST_STRATEGY.en.md)                                                                                                                                                                                                                  | What each suite runs and what it does not replace                                    |
| Flows               | [Flow matrix](FLOW_MATRIX.en.md)                                                                                                                                                                                                                      | Response table by result and graphs of HTTP and queue flows                          |
| Invariants          | [Invariant review](INVARIANT_REVIEW.en.md)                                                                                                                                                                                                            | Invariants, database constraints, and decisions that depend on the challenge owner   |
| Final audit         | [Final audit](AUDITORIA_FINAL.en.md)                                                                                                                                                                                                                  | Status of each risk matrix item, owner's decisions, and actual pending items         |
| Audit               | [Audit index](audit/README.md)                                                                                                                                                                                                                        | Evidence for each guarantee, findings, coverage, and performance comparisons         |
| Load                | [Load results](LOAD_TEST_RESULTS.md), [local baseline](LOAD_TEST_BASELINE.en.md), and [load history](LOAD_TEST_HISTORY.en.md)                                                                                                                         | Cloud results, local baseline with 13 scenarios, and run history                     |
| Implementation plan | [Implementation plan](IMPLEMENTATION_PLAN.en.md)                                                                                                                                                                                                      | Appendix: record of implemented slices                                               |
| Modules             | [Module boundaries](../src/modules/README.en.md)                                                                                                                                                                                                      | What each module owns and what it cannot do                                          |
| HTTP contract       | [OpenAPI](openapi.json)                                                                                                                                                                                                                               | API contract, checked against the routes                                             |
| Diagrams            | [Diagrams](diagrams/)                                                                                                                                                                                                                                 | SVG diagrams used in the README and flow matrix                                      |
| Conventions         | [Documentation conventions](CONVENCOES_DOCUMENTACAO.en.md)                                                                                                                                                                                            | Language, English pairs, generated files, and how to change documentation            |
| Agent instructions  | [CLAUDE.md](../CLAUDE.md)                                                                                                                                                                                                                             | Project rules for coding agents (maintained in English)                              |
| Agent runbooks      | [financial](runbooks/financial-change.en.md), [concurrency](runbooks/concurrency-debugging.en.md), [messaging](runbooks/messaging-recovery.en.md), [migrations](runbooks/database-migration.en.md), [review](runbooks/code-review-verification.en.md) | Focused procedures by change type, each with an English reference                    |

## Generated files

These files are produced by tools. Do not edit them by hand, because the next run will overwrite their contents:

- [`LOAD_TEST_RESULTS.md`](LOAD_TEST_RESULTS.md): generated by `test/load/report.ts` from `docs/load/results/`.
- `docs/load/`, `docs/edge/results/`, and `docs/audit/perf/`: raw measurements in JSON, produced by load and performance tests.
