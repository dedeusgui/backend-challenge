# Final Adversarial Hardening Plan

> **For agentic workers:** execute each independent slice in its own worktree and branch; commit with Conventional Commits. The coordinator integrates, reviews every diff, and runs the final gates.

**Goal:** Close reproducible correctness and test reliability gaps without changing confirmed financial behavior, then produce evidence tied to the final commit.

**Architecture:** Keep Compose as the primary development and load-test path. Add only an optional Testcontainers pilot. Reuse the existing database, queue, process-cluster, demo, and gate helpers; make test-resource cleanup unconditional and make evidence parsers reject incomplete data. Additive migrations preserve existing records and behavior.

**Tech Stack:** Bun 1.4.4, TypeScript 6, NestJS 12, MikroORM 7, PostgreSQL 17, LocalStack 4.14.0, Docker Compose, GitHub Actions.

**Spec:** User request, “FINAL ADVERSARIAL REVIEW & ENGINEERING HARDENING”.

## Global Constraints

- Preserve D1–D4 and all confirmed transaction/API behavior.
- Keep PostgreSQL and LocalStack real in integration tests; do not replace them with mocks.
- Keep Compose as the default development, demo, and load-test infrastructure.
- Do not push, merge, or publish; external GitHub execution cannot be claimed without a hosted PR run.
- Leave tracked source changes in the original checkout untouched; implement on isolated worktrees.
- Report only runs observed against the final commit and state limitations explicitly.

## Review Focus

- Empty or truncated logs must never become a passing gate record; test empty, partial, valid, and failed transcripts.
- Failed setup/teardown must preserve the original failure while always releasing the database, queues, and clients.
- SQL must independently reject a broken ledger chain even when the net sum still equals the wallet balance.
- Testcontainers must run under Bun 1.4.4 with dynamically mapped ports before the pilot is accepted.
- CI and security workflows must use least privilege and be described as unverified when no hosted PR execution is available.

## Approaches

- Retain Compose only: smallest change, but does not satisfy the requested isolated-container experiment.
- Replace Compose with Testcontainers: rejected because it would change the primary developer and load-test workflow.
- Keep Compose primary and add a representative optional Testcontainers command: selected by the user's explicit requirements; compare actual runs before deciding whether to add a CI job.

---

### Task 1: Fail-closed gate evidence

**Files:** `scripts/record-gate.ts`, new gate unit tests, output schema and CLI metadata.

- [ ] Require every expected suite marker and a real summary for each suite.
- [ ] Validate pass/fail/total arithmetic, Cucumber skipped steps and explicit exit status.
- [ ] Bind records to the tested commit and environment; reject missing metadata and truncated transcripts.
- [ ] Prove empty/partial logs fail and a complete passing transcript passes.

### Task 2: Database invariants and setup cleanup

**Files:** additive migration, schema integration tests, `scripts/financial-invariants.sql`, runner and package script.

- [ ] Reproduce the valid-net-sum/broken-chain commit, then enforce the chain at PostgreSQL commit.
- [ ] Add read-only INV-1…INV-11 checks that exit nonzero on violations; report INV-12 migration count explicitly.
- [ ] Guarantee temporary DB closure/drop on setup, migration, assertion, and teardown failures while preserving original errors.

### Task 3: Queue cleanup and optional Testcontainers pilot

**Files:** `test/integration/support/{test-database,sqs-test-queues}.ts`, ProcessCluster cleanup, Testcontainers bootstrap and selected tests.

- [ ] Delete only UUID-owned test queues; clean partial creation; close clients and child processes.
- [ ] Under Bun 1.4.4, start one PostgreSQL and one LocalStack container per invocation with dynamic ports.
- [ ] Run one persistence, one SQS, and one independent-process concurrency suite; retain Compose as primary.
- [ ] Capture logs on failure, propagate exit status, and stop containers in `finally`.
- [ ] Compare startup/runtime and cleanup with the Compose path; add a CI job only if repeatable.

### Task 4: HTTP validation and runtime/CI checks

**Files:** request validation and regression tests; GitHub Actions workflows, Docker setup, runtime smoke.

- [ ] Reject all prohibited Unicode control characters at the existing input boundary.
- [ ] Exercise Compose health, migrations, API/worker readiness, real financial demo, replay, reconciliation, and one queue flow.
- [ ] Add least-privilege security checks only where they can be configured honestly; mark hosted-runner checks pending if unavailable.
- [ ] Avoid repeating the quality gate in integration jobs.

### Task 5: Documentation and final evidence

**Files:** Portuguese/English audit pairs, reviewer guide, matrices, runbooks, generated site inputs as appropriate.

- [ ] Correct stale counts and ROLLBACK-before-reference claims from source evidence; preserve historical snapshots as historical.
- [ ] Correct links to cloud/local load results and describe absent commands/tools accurately.
- [ ] Run final checks, record SHA/date/environment/commands/results/limitations, build Pages and review the final diff.
