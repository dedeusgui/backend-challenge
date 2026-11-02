# Reviewer guide

> English reference copy. The main version, in Brazilian Portuguese, is [REVIEWER_GUIDE.md](REVIEWER_GUIDE.md).

This guide shows how to verify the solution in about 40 minutes without help from its author. Each claim points to a command or file that supports it; limits are stated where a check does not prove a claim.

## 1. Start the stack and demo (10 min)

```bash
docker compose up --build
curl http://localhost:3000/health/ready
bun run demo:finance
```

The demo calls the API against the running stack. It opens a wallet with 100.00, makes a bet, a win, another bet with refund, and rolls back the win. It checks balances, rejects a second rollback, replays a bet, and reconciles the ledger. It does not simulate API calls. If a TLS proxy prevents package downloads during the image build, see [ARCHITECTURE.md §14](../ARCHITECTURE.en.md); the old run `41251559996` is historical and does not prove the current HEAD build or CI.

## 2. Read the architecture (5 min)

Start with [ARCHITECTURE.en.md](../ARCHITECTURE.en.md), especially its decision table. Sections 5–9 describe concurrency, idempotency, messaging, outbox and out-of-order references.

## 3. Run the suites (5 min)

```bash
bun run infra:up
bun run check:all
```

`check:all` runs types, lint, formatting, unit, infrastructure, integration, concurrency and e2e suites against PostgreSQL 17 and LocalStack. Counts and timings vary by commit and environment; use a report that names its SHA and runner. `bun run test:containers` is an alternative local pilot. See [TEST_STRATEGY.en.md](TEST_STRATEGY.en.md) for suite limits and process-crash evidence.

With the stack and migrations running, `bun run check:financial-invariants` inspects the database in a read-only transaction. It does not change data or replace tests, and SQL alone cannot prove TypeScript behavior or post-commit publication. See [INVARIANT_REVIEW.en.md](INVARIANT_REVIEW.en.md).

## 4. Three important tests (5 min)

| Requirement                              | Command                                                                                              | Expected observation                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 50 identical bets across three processes | `bun test test/concurrency/three-processes.test.ts -t "fifty identical requests"`                    | one debit; the rest are replays                          |
| Competing for the same balance           | `bun test test/concurrency/hot-wallet.test.ts`                                                       | exactly one 80.00 bet is applied to 100.00               |
| API killed after commit, before response | `bun test test/concurrency/process-crash-and-shutdown.test.ts -t "HTTP process killed after commit"` | retry returns replay; debit and event are not duplicated |

Mutation evidence is recorded in [TEST_STRATEGY.en.md](TEST_STRATEGY.en.md). For other guarantees, [audit/README.md](audit/README.md) points to supporting tests.

## 5. Authentication and authorization (5 min)

- `test/e2e/auth-http.test.ts`: permissions by role.
- `test/e2e/authorization-adversarial.test.ts`: attempts to bypass authorization by route, header, identifier and revoked key.
- A provider requesting another provider's transaction receives `404`, as for a missing identifier. F-03's implementation finding is closed; the historical contract question is described in [AUDITORIA_FINAL.en.md](AUDITORIA_FINAL.en.md).

## 6. HTTP contract (5 min)

[openapi.json](openapi.json) describes eleven operations and is served at `GET /openapi.json`; Swagger UI is at `GET /docs`. `test/unit/openapi/openapi-contract.test.ts` checks structure and route parity, while `test/e2e/openapi-responses.test.ts` checks real responses against the contract.

## 7. Protected mode and exposed ports (5 min)

```bash
export COMPOSE_PROJECT_NAME="edge-review-$(date +%s)"
export EDGE_NETWORK="${COMPOSE_PROJECT_NAME}_default"
export EDGE_HOST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
bun run edge:check
```

In default mode PostgreSQL, LocalStack and the API bind only to `127.0.0.1`; protected mode exposes only the edge, also on loopback. `test/infra` and `test:edge` inspect the effective Compose setup and running container. CI's `protected-edge` job uses an isolated project, network and port.

## 8. Messaging guarantees and limits

See [ARCHITECTURE.en.md §8](../ARCHITECTURE.en.md). Events are retried without a fixed attempt limit, but arrival order is not guaranteed. Outbox leases and retries use the database clock; in-flight messages are renewed up to 300 seconds. A permanent held-reference failure becomes `FAILED` and emits `WagerTransactionFailed`, which the brief does not list.

`bun run smoke:sqs-worker` checks the real Compose worker when `API_URL`, `DATABASE_URL` and `SQS_ENDPOINT` point to that stack. It sends two FIFO commands, checks status/balance/ledger and verifies a single debit after replay.

## 9. What was not built or measured

- Queue visibility-renewal cost and throughput were not measured; load tests send HTTP only. See [PERFORMANCE_COMPARISON.md](audit/PERFORMANCE_COMPARISON.md).
- An engineering console and load lab were not built; see [AUDITORIA_FINAL.en.md](AUDITORIA_FINAL.en.md).
- Prometheus and Grafana are not installed; `/metrics` is per process.
- `fast-check` tests cent-accurate arithmetic with a reproducible seed and shrinking in `test/unit/shared/domain/money.property.test.ts`. An independent model compares bounded financial sequences, replays and ledger entries with PostgreSQL in `test/integration/model/financial-reference-model.test.ts`. See [TEST_STRATEGY.en.md](TEST_STRATEGY.en.md) for mutation evidence and limits; earlier generated sequences remain in `test/integration/model/random-sequences.test.ts`.
- Public benchmark comparisons were not rerun in this session. Cloud and local numbers come from different machines.

## 10. Known limits

See [ARCHITECTURE.en.md §14](../ARCHITECTURE.en.md). Production-relevant limits include API keys without rotation or login, HTTP requiring TLS at the edge, no rate limit in default mode, and a WIN without reference that cannot be associated with its BET or prevent a refund against it. A second settlement of the same BET is rejected with `REFERENCE_ALREADY_SETTLED`.

A message running longer than 300 seconds may be released while still processing; two consumers can then process it concurrently. Transaction identity keeps the financial effect to one.

## 11. Security automation

CodeQL, Trivy, Dependency Review and Dependabot are configured, but this does not establish hosted results. See [SECURITY_AUTOMATION.en.md](SECURITY_AUTOMATION.en.md).
