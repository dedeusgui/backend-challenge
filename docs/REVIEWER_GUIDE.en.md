# Reviewer guide

English reference copy. The main version, in Portuguese, is [REVIEWER_GUIDE.md](REVIEWER_GUIDE.md).

This guide shows how to verify the solution in about 40 minutes, without guidance from its author. Each claim points
to the command or file that proves it. When an item is not proven, the guide says so.

## 1. Run the stack and demo (10 min)

```bash
docker compose up --build
curl http://localhost:3000/health/ready
bun run demo:finance
```

The demo requires the stack to be running: it calls the API, and the stack applies the database migrations. Without the
stack, the demo fails when creating the first key, with a message asking you to check the database and migrations.

The demo opens a wallet with 100.00, places a bet, records a win, places another bet with its refund, and rolls back the
win. It checks each balance, rejects a second rollback, replays a bet, and compares the ledger sum with the balance and
reconciliation. Each step prints what was observed. It does not simulate anything: it calls the API.

If `docker compose up --build` fails in an environment with a TLS proxy that blocks package downloads during the build,
see [ARCHITECTURE.md §14](../ARCHITECTURE.en.md) for the limitation observed in that environment. The old run
`41251559996` is historical and does not prove the current HEAD build or CI.

## 2. Read the architecture through the decision table (5 min)

[ARCHITECTURE.en.md](../ARCHITECTURE.en.md), the table at the beginning. Each decision has its reason, accepted cost, test
that proves it, and ADR with alternatives. Sections 5 to 9 develop concurrency, idempotency, messaging, the outbox, and
out-of-order references.

## 3. Confirm that the suites pass (5 min)

```bash
bun run infra:up
bun run check:all
```

`check:all` runs types, lint, formatting, unit tests, infrastructure tests, integration, concurrency, and e2e against
real PostgreSQL 17 and LocalStack. Counts and timings change by commit and environment; use the run report that states
the SHA and runner, and do not treat old measurements as current.

The recommended command remains the gate against the Compose stack. For an alternative local pilot, use
`bun run test:containers`; to choose files, append `-- <arquivo>`. Measured results and pilot limits are in
[TEST_STRATEGY.en.md](TEST_STRATEGY.en.md), including failure points covered with `SIGKILL`.

### Read-only SQL checker

With the stack running and migrations applied, this command inspects the database in a read-only transaction:

```bash
bun run check:financial-invariants
```

The command uses `DATABASE_URL` when defined; otherwise, it uses the local default. `bun run agent:verify` runs the fast
gate and the dead-code check; financial, persistence, or infrastructure changes also require `bun run check:all`. The
SQL command does not change data or replace tests. The SQL queries alone do not prove behavioral properties such as the
use of `Money` in TypeScript, the absence of a global lock, or publication after commit. See
[INVARIANT_REVIEW.en.md](INVARIANT_REVIEW.en.md) for the full limits.

## 4. The three most important tests (5 min)

| Requirement                                    | Command                                                                                              | What to observe                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 50 identical bets in parallel, three processes | `bun test test/concurrency/three-processes.test.ts -t "fifty identical requests"`                    | one debit; the others are replays                        |
| Dispute over the same balance (scenario in §8) | `bun test test/concurrency/hot-wallet.test.ts`                                                       | exactly one 80.00 bet is applied to 100.00               |
| Worker killed after commit and before ACK      | `bun test test/concurrency/three-processes.test.ts -t "crashes after commit and before ACK"`         | redelivery applies once; balance and ledger match        |
| API killed after commit and before response    | `bun test test/concurrency/process-crash-and-shutdown.test.ts -t "HTTP process killed after commit"` | retry returns replay; debit and event are not duplicated |

To see that the concurrency tests are not empty, see the mutations recorded in [TEST_STRATEGY.en.md](TEST_STRATEGY.en.md),
in the "Mutation evidence" section: removing the lock or version guard makes the test fail.

For any other guarantee, the [audit/README.md](audit/README.md) index points to the test that proves it.

## 5. Authentication and authorization (5 min)

- `test/e2e/auth-http.test.ts`: what each role can do.
- `test/e2e/authorization-adversarial.test.ts`: 28 attempts to bypass the rule, by route, header, identifier, and revoked key.
- The applied decision: a provider key requesting another provider's transaction by internal id receives `404`, just like a nonexistent id. The adversarial test proves isolation and prevents revealing existence. Implementation finding F-03 is closed; the historical contract question is recorded in [AUDITORIA_FINAL.en.md](AUDITORIA_FINAL.en.md).

## 6. HTTP contract (5 min)

[openapi.json](openapi.json) describes the eleven operations, and the same specification is served at `GET /openapi.json`,
with the interface at `GET /docs`. Two checks keep it honest:
`test/unit/openapi/openapi-contract.test.ts` (structure and parity with registered routes) and
`test/e2e/openapi-responses.test.ts` (each real response must have a documented status and valid body). The second
found a discrepancy, and the contract was corrected: ledger `seq` is text.

## 7. Protected mode and port exposure (5 min)

```bash
export COMPOSE_PROJECT_NAME="edge-review-$(date +%s)"
export EDGE_NETWORK="${COMPOSE_PROJECT_NAME}_default"
export EDGE_HOST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
bun run edge:check
```

In default mode, PostgreSQL, LocalStack, and the API publish ports only on `127.0.0.1`. In protected mode, only the edge
publishes a port, also on `127.0.0.1`. `test/infra` and `test:edge` check this in the effective Compose setup and the
running container.

The `protected-edge` job runs this same command with a unique project name, network, and port for each CI run; Compose
logs are attached if the test fails.

## 8. Messaging: what is and is not guaranteed

Read [ARCHITECTURE.md §8](../ARCHITECTURE.en.md), the "What an external consumer can rely on" section. In summary: every
event arrives (attempts have no ceiling; only the delay is limited); `eventId` identifies the fact;
`walletVersion` orders balance changes for a wallet. Arrival order is **not** guaranteed: a rejected event is retried
later, and a later event for the same wallet may arrive first. `partial-batch-order.test.ts` shows this sequence in real
SQS.

Since this iteration, outbox lease and rescheduling are decided by the database clock
(`outbox-lease-clock.test.ts`, `outbox-retry-clock.test.ts`), as is the holds worker
(`database-clock-references.test.ts`). An in-flight message is renewed while its command runs, up to 300 s
(`slow-message-hold.test.ts`). A permanently failed hold becomes `FAILED` and is announced as `WagerTransactionFailed`,
an event not listed in the specification (see F-13 in [FINDINGS.md](audit/FINDINGS.md)).

To verify the real stack consumer, bring up the complete Compose setup and run `bun run smoke:sqs-worker` with `API_URL`,
`DATABASE_URL`, and `SQS_ENDPOINT` pointing to the stack. The smoke test opens a wallet through the API, sends two distinct
commands to the FIFO queue (the second repeats the same financial operation), waits for the Compose worker, checks balance,
status, and ledger through PostgreSQL/API, and requires a single debit. It does not instantiate a test consumer.

## 9. What was not done, and why

- **Visibility renewal cost and queue consumer throughput.** Not measured: the load test sends HTTP only. See
  [PERFORMANCE_COMPARISON.md](audit/PERFORMANCE_COMPARISON.md), experiments 2 and 4.
- **Engineering console and load lab.** Not built in this iteration. The telemetry that a console would show became true
  only with the worker surface; a dashboard over the current numbers would be premature. See
  [AUDITORIA_FINAL.en.md](AUDITORIA_FINAL.en.md).
- **Prometheus and Grafana.** Not installed. Per-process `/metrics` and the worker surface cover the evaluation; an
  aggregator would require collection per instance, and that has not yet been proven in execution.
- **Financial properties.** `fast-check` covers cent arithmetic with a reproducible seed and shrinking in
  `test/unit/shared/domain/money.property.test.ts`. An independent model also compares bounded financial sequences,
  replays, and ledger with real PostgreSQL in `test/integration/model/financial-reference-model.test.ts`. Mutation
  evidence and limits are in [TEST_STRATEGY.en.md](TEST_STRATEGY.en.md); earlier integration sequences remain in
  `test/integration/model/random-sequences.test.ts`.
- **Comparison with public references.** Not rerun in this session. The numbers in `docs/LOAD_TEST_RESULTS.md` are from
  previous runs on a four-vCPU VM and should not be compared with another machine without noting that.
- **Local measurement.** The baseline in `docs/LOAD_TEST_BASELINE.md` measures 13 scenarios on my machine, with the
  agreed rates and the correction at each step. It should not be read as an improvement over the cloud: these are
  different machines.

## 10. Known limits

The complete list is in [ARCHITECTURE.md §14](../ARCHITECTURE.en.md). The most consequential for a production decision:
API keys without rotation or login; plain HTTP behind TLS to be added; no rate limit in default mode; a `WIN` without a
reference that does not block its bet's `REFUND`; a `WIN` resent under another external id, without naming the BET, is
counted as a second credit. A second settlement of the same BET is rejected with `REFERENCE_ALREADY_SETTLED`.

- An in-flight message that runs beyond 300 s is released, and two consumers can process the same command at the same
  time. Transaction identity keeps the effect to one (`slow-message-hold.test.ts`).

## 11. Security automation

CodeQL, Trivy, Dependency Review, and Dependabot are configured in the workflows. Hosted results on GitHub and PR runs
were not executed or reviewed in this session. See [SECURITY_AUTOMATION.en.md](SECURITY_AUTOMATION.en.md).
