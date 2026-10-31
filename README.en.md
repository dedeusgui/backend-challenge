# Distributed Wagering Processor (English)

Portuguese is the primary language of this repository: see [README.md](README.md). This file is the English version of the same guide.

Implementation of the [Jungle Gaming backend challenge](docs/CHALLENGE.md). It applies wager
operations (BET, WIN, LOSS, REFUND, ROLLBACK) from game providers over HTTP and SQS, keeps
balances consistent under concurrency, duplicates and crashes, and reconciles each wallet against
its ledger.

## Reading order

1. **This README**: how to run and test the service.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)**: the flow, the main decisions (the table at its start
   gives each one with its reason and its evidence), and the limitations in section 14.
3. **Contract**: [docs/openapi.json](docs/openapi.json), checked against the routes and the real answers.
4. **Reproducible evidence**: [docs/REQUIREMENTS_MATRIX.md](docs/REQUIREMENTS_MATRIX.md) links each
   requirement to the test that proves it. [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md) says what each
   suite runs and what it does not replace.
5. **Appendices, for deeper reading**: the [ADR index](docs/adr/README.md) and its records;
   [DECISIONS.md](DECISIONS.md), every decision with its evidence; the reviews in
   [docs/INVARIANT_REVIEW.md](docs/INVARIANT_REVIEW.md) and [docs/REFERENCE_REVIEW.md](docs/REFERENCE_REVIEW.md);
   [docs/FLOW_MATRIX.md](docs/FLOW_MATRIX.md); the load reports in
   [docs/LOAD_TEST_RESULTS.md](docs/LOAD_TEST_RESULTS.md) and [docs/LOAD_TEST_HISTORY.md](docs/LOAD_TEST_HISTORY.md);
   the [implementation log](docs/IMPLEMENTATION_PLAN.md); and the [specification](docs/CHALLENGE.md), kept verbatim.

## Run

Requirements: Bun **1.4.4**, the version pinned in CI and in the Dockerfile, and Docker with Compose.

```bash
docker compose up --build
curl http://localhost:3000/health/ready
# {"status":"ok","checks":{"database":"up","sqs":"up"}}
```

Compose starts PostgreSQL and LocalStack, which provisions the queues `wager-transactions.fifo`,
`wager-transactions-dlq.fifo` and `wager-events.fifo`. It runs the migrations once, then starts the API
on port 3000 and the worker. The API starts only after the migration has succeeded. Every published port
binds `127.0.0.1` (set `PUBLISH_HOST` to change it). The worker exposes its liveness and metrics on the
internal port 3001, which is not published.

For local development, without the API and worker containers:

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run infra:up              # PostgreSQL and LocalStack, with health checks
bun run db:migrate            # apply migrations
bun run dev                   # API with restart on change
bun run src/worker.ts         # worker, in another terminal
```

## Protected mode (optional)

The default mode above has no rate limit. The protected mode puts an Nginx edge in front of the API. It limits
each client address, and it refuses the rest with 429. The API publishes no port of its own in this mode, so the
edge is the only way in. The public port is the same, 3000.

```bash
docker compose -f docker-compose.yml -f docker-compose.protected.yml up --build
bun run test:edge                 # the protected-mode suite, against the running stack
docker compose -f docker-compose.yml -f docker-compose.protected.yml down
```

The limits are set with `EDGE_WRITE_RATE` (20r/s), `EDGE_WRITE_BURST` (40), `EDGE_READ_RATE` (50r/s),
`EDGE_READ_BURST` (100) and `EDGE_MAX_CONNECTIONS` (50). A refused request is 429 with `Retry-After`, and its body
is JSON. Health checks are not limited. `bun run edge:check` starts the stack, runs the suite and stops it.
`bun run bench:edge <label>` measures the cost of the edge against the API. `ARCHITECTURE.md` section 15 gives the
design, what it does not protect, and the measured cost.

## Test

```bash
bun install --frozen-lockfile
bun run infra:up              # the integration, concurrency and e2e suites need PostgreSQL and LocalStack
bun run check:all             # the final gate: typecheck, lint, format, and every suite
```

| Command                    | Purpose                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `bun run check:fast`       | typecheck, lint, format and unit tests, with no infrastructure             |
| `bun run test:unit`        | domain and pure-logic tests                                                |
| `bun run test:integration` | PostgreSQL and LocalStack: schema, persistence, messaging, faults          |
| `bun run test:concurrency` | parallel connections, three API processes, a worker killed or stopped      |
| `bun run test:e2e`         | the HTTP application, with API keys                                        |
| `bun run check:all`        | everything above. This is the gate, and CI runs it                         |
| `bun run test:load`        | optional load run per CPU count; writes the report (Linux)                 |
| `bun run test:edge`        | protected mode: the edge's limits and isolation, against the running stack |
| `bun run edge:check`       | starts the protected stack, runs `test:edge`, and stops the stack          |
| `bun run demo:finance`     | demonstration 1: the financial flow, against the running API               |
| `bun run db:migrate`       | apply pending migrations and exit                                          |
| `bun run auth:create`      | create an API client and print its key once                                |
| `bun run auth:revoke`      | revoke an API client by id                                                 |

No suite replaces PostgreSQL or the queue with a mock. Each concurrency test asserts that exactly one
operation has the effect and that the others are replays, conflicts or rejections.
`docs/TEST_STRATEGY.md` maps each specification requirement to its suite.

The load test pins the stack to a number of CPUs and ramps the request rate in steps. Its method and
results are in `docs/LOAD_TEST_RESULTS.md`. The numbers describe the machine that ran them.

## Demonstrations

Three scenarios show the guarantees. Each one prints its result, and each needs only the commands below.

1. **Financial processing.** Start the stack (`docker compose up --build`), then run
   `bun run demo:finance`. It opens a wallet with 100.00, runs a BET, a WIN, a BET and its REFUND, and a ROLLBACK
   of the WIN, and it checks every balance, the refusal of a second ROLLBACK, the replay of a BET, the ledger sum
   and the reconciliation.
2. **Concurrency.** `bun test test/concurrency/three-processes.test.ts -t "fifty identical requests"`. Fifty
   identical requests run in parallel over three API processes and one database. One debit is applied, and the
   other requests are replays of the same transaction.
3. **Recovery.** `bun test test/concurrency/three-processes.test.ts -t "crashes after commit and before ACK"`. A
   worker process exits with code 137 after its command has committed and before the message is acknowledged. A
   restarted worker takes the message back. The queue is drained, the balance is 75.00, the ledger sums to
   75.00, and it holds exactly one debit for the command.

## Endpoints

Amounts are always `{ "amount": "25.00", "currency": "BRL" }`. Every route needs an API key,
sent as `Authorization: Bearer <key>`, except `/health/live` and `/health/ready`. An operator
key opens and reads wallets. A provider key submits and reads the operations of its own provider
id only. Keys are created with the `auth` command, which prints each one once:

```bash
docker compose exec api bun run auth:create -- --name operations --role OPERATOR
docker compose exec api bun run auth:create -- --name provider-a --role PROVIDER --provider provider-a
```

| Method and path                                                           | Purpose                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `POST /wallets`                                                           | create a wallet, with an optional opening balance (201; 409 if it exists) |
| `GET /wallets/:walletId`                                                  | balance, version and currency                                             |
| `GET /wallets/:walletId/ledger?cursor=&limit=`                            | ledger pages in sequence order, with an opaque `nextCursor`               |
| `POST /wagering/transactions`                                             | submit an operation, with `Idempotency-Key` (201, 200, 202 or 422)        |
| `GET /wagering/transactions/:transactionId`                               | one transaction                                                           |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | the same, by the provider's own id                                        |
| `POST /wallets/:walletId/reconciliation`                                  | recompute the balance from the ledger and report any divergence           |
| `GET /health/live`, `GET /health/ready`                                   | the process is up; PostgreSQL and the command queue answer                |
| `GET /metrics`                                                            | counters and summaries of this process                                    |

A rejected operation returns 422 with a `failureCode`. `ARCHITECTURE.md` section 3 lists the codes,
and section 10 gives the status of every error.

```bash
# Submit a BET. The Idempotency-Key header is required, and it is the source of truth.
curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -H "authorization: Bearer $PROVIDER_A_KEY" \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<wallet id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

## Queue

The worker consumes `WagerTransactionRequested` messages from `wager-transactions.fifo`, in the body
shape of the specification (section 10), and calls the same use case as HTTP. A message is
acknowledged only after its transaction commits. Permanent failures go to
`wager-transactions-dlq.fifo`. The worker publishes `WagerTransactionProcessed`,
`WagerTransactionRejected`, `WalletBalanceChanged` and `WagerTransactionPendingReference` to
`wager-events.fifo`.

## Main limitations

The full list is in `ARCHITECTURE.md` section 14. The most important:

- **API keys, not an identity provider.** Keys last until revoked, with no rotation or login. The API
  serves plain HTTP, so a deployment must put it behind TLS. See [ADR 0007](docs/adr/0007-api-key-authentication.md).
- **Rate limiting is per client address, and only in protected mode.** It is not protection against a
  distributed attack, and the default mode has none. See `ARCHITECTURE.md` section 15.
- **Local infrastructure only.** LocalStack stands in for SQS. No AWS deployment was made.
- **The Dockerfile image build** could not run in the authoring sandbox, whose TLS proxy blocks package
  downloads. The stack was verified from clean volumes with an image built from the same source and the
  sandbox CA.
- **Interpretations that need the owner's confirmation** are listed in `ARCHITECTURE.md` section 13 and
  `docs/INVARIANT_REVIEW.md`. The most consequential is that an unnamed WIN does not block a REFUND of its BET.

## Repository layout

```text
src/
  main.ts                 API entrypoint (HTTP)
  worker.ts               worker entrypoint (SQS consumer, outbox publisher, reference resolver)
  migrate.ts              one-shot schema migration
  app.module.ts           composition root shared by production and tests
  config/                 environment parsing, fail-fast
  health/ metrics/        probes and the metrics endpoint
  modules/
    wallet/               Wallet, ledger, opening, queries, reconciliation
    wagering/             WagerTransaction, settlement, references, HTTP
    messaging/            inbox, outbox, SQS adapters, command consumer, publisher
    auth/                 API keys, roles and provider scope
  shared/                 Money, errors, unit of work port, events, validation, observability
  shared/infrastructure/database/migrations/   versioned, reversible migrations
test/
  unit/                   domain and pure logic
  integration/            schema, persistence, use cases, messaging, faults
  concurrency/            parallel connections and real processes
  e2e/                    HTTP
  load/                   optional load test: workload, pinning, measurement, report
docker/localstack/        queue provisioning
docker/edge/              the protected mode's Nginx template and forwarding headers
docker-compose.protected.yml  the protected mode, as an override of docker-compose.yml
test/edge/                protected-mode suite, and the edge overhead measurement
test/demo/                demonstration 1, the financial flow
```
