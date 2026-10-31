# Distributed Wagering Processor

Implementation of the [Jungle Gaming backend challenge](https://github.com/junglegaming/backend-challenge).
The [original specification](docs/CHALLENGE.md) is kept verbatim. This service applies wager
operations (BET, WIN, LOSS, REFUND, ROLLBACK) from game providers over HTTP and SQS, keeps
balances consistent under concurrency, duplicates and crashes, and reconciles each wallet
against its ledger.

- [ARCHITECTURE.md](ARCHITECTURE.md): components, guarantees, diagrams, limitations.
- [docs/REQUIREMENTS_MATRIX.md](docs/REQUIREMENTS_MATRIX.md): each requirement, its test and its status.
- [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md): suites, isolation, fault injection.
- [docs/adr](docs/adr): the decisions and their trade-offs.
- [docs/REFERENCE_REVIEW.md](docs/REFERENCE_REVIEW.md): the three public reference implementations.
- [DECISIONS.md](DECISIONS.md): every technical decision, with its reason, trade-off, evidence and status.
- [docs/FLOW_MATRIX.md](docs/FLOW_MATRIX.md): the flow of data: colour-coded graphs, the function-by-entity matrix, the response table, and every entity with its table and methods.
- [docs/INVARIANT_REVIEW.md](docs/INVARIANT_REVIEW.md): the review of every invariant and constraint, and the decisions the owner must confirm.
- [docs/LOAD_TEST_RESULTS.md](docs/LOAD_TEST_RESULTS.md): the optional load test, one run per CPU count, with its environment and its limits.

## Stack

Bun 1.4.4 · TypeScript (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 17 · AWS SQS (LocalStack 4.14) · Docker Compose.

## Requirements

- Bun **1.4.4**, the version pinned in CI and the Dockerfile.
- Docker with Compose, for PostgreSQL and LocalStack.

## Run the whole stack

```bash
docker compose up --build
```

Compose starts PostgreSQL and LocalStack, which provisions the queues
`wager-transactions.fifo`, `wager-transactions-dlq.fifo` and `wager-events.fifo`. It then
runs the migrations once, and starts the API on port 3000 and the worker. The API starts
only after the migration has succeeded.

```bash
curl http://localhost:3000/health/ready
# {"status":"ok","checks":{"database":"up","sqs":"up"}}
```

For local development without the API and worker containers:

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run infra:up              # PostgreSQL and LocalStack, with health checks
bun run db:migrate            # apply migrations
bun run dev                   # API with restart on change
bun run src/worker.ts         # worker, in another terminal
```

## Commands

| Command                    | Purpose                                                 |
| -------------------------- | ------------------------------------------------------- |
| `bun run db:migrate`       | apply pending migrations and exit                       |
| `bun run auth:create`      | create an API client and print its key once             |
| `bun run auth:revoke`      | revoke an API client by id                              |
| `bun run typecheck`        | strict TypeScript check                                 |
| `bun run lint`             | oxlint                                                  |
| `bun run format:check`     | Prettier                                                |
| `bun run test:unit`        | domain and pure-logic tests, no infrastructure          |
| `bun run test:integration` | PostgreSQL and LocalStack integration tests             |
| `bun run test:concurrency` | real concurrency, and three API processes plus a worker |
| `bun run test:e2e`         | HTTP end-to-end tests                                   |
| `bun run test:load`        | optional load run per CPU count, writes the report      |
| `bun run check:fast`       | typecheck, lint, format and unit tests                  |
| `bun run check:all`        | everything above, which is the final gate               |

Run `bun run infra:up` before the suites that need PostgreSQL or LocalStack.

## Endpoints

Amounts are always `{ "amount": "25.00", "currency": "BRL" }`.

Every route needs an API key, sent as `Authorization: Bearer <key>`, except `/health/live` and
`/health/ready`. An operator key opens and reads wallets and reads metrics. A provider key
submits and reads the operations of its own provider id only. Create a key with the `auth`
command, which prints it once:

```bash
docker compose exec api bun run auth:create -- --name operations --role OPERATOR
docker compose exec api bun run auth:create -- --name provider-a --role PROVIDER --provider provider-a
```

See `ARCHITECTURE.md` section 12 and `docs/adr/0007-api-key-authentication.md`.

```bash
# Open a wallet, with an optional opening balance (operator key)
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -H "authorization: Bearer $OPERATOR_KEY" \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# Submit a BET. The Idempotency-Key header is required and is the source of truth (provider-a key)
curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -H "authorization: Bearer $PROVIDER_A_KEY" \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<wallet id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

| Method and path                                                           | Purpose                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /wallets`                                                           | create a wallet (201, or 409 if one exists for the player and currency)                 |
| `GET /wallets/:walletId`                                                  | balance, version, currency                                                              |
| `GET /wallets/:walletId/ledger?cursor=&limit=`                            | ledger pages in sequence order, with an opaque `nextCursor`                             |
| `POST /wagering/transactions`                                             | submit an operation. 201 applied, 200 replay, 202 waiting for a reference, 422 rejected |
| `GET /wagering/transactions/:transactionId`                               | one transaction                                                                         |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | the same, by provider id                                                                |
| `POST /wallets/:walletId/reconciliation`                                  | recompute the balance from the ledger and report any divergence. It never corrects      |
| `GET /health/live`                                                        | the process is up                                                                       |
| `GET /health/ready`                                                       | PostgreSQL and the command queue answer                                                 |
| `GET /metrics`                                                            | counters and summaries of this process                                                  |

A rejected operation returns 422 with a `failureCode`. The codes and the status taxonomy
are in `ARCHITECTURE.md` sections 3 and 10.

## Queue contract

The worker consumes `WagerTransactionRequested` messages from `wager-transactions.fifo`
with the body shape in the specification (section 10). A message is acknowledged only after
its transaction commits. Permanent failures go to `wager-transactions-dlq.fifo`. The
worker publishes `WagerTransactionProcessed`, `WagerTransactionRejected`,
`WalletBalanceChanged` and `WagerTransactionPendingReference` to `wager-events.fifo`.

## Simulating concurrency

The distributed proof starts independent processes, all against the same PostgreSQL and LocalStack:

```bash
bun run infra:up
bun run test:concurrency
```

- `test/concurrency/three-processes.test.ts`: three API processes and a worker. Two bets of 80.00 on
  100.00 from two processes at once, fifty identical requests over three processes, twelve wallets in
  parallel, a worker killed between commit and acknowledgement, and a graceful SIGTERM.
- `test/concurrency/distributed-contention.test.ts`: three API processes and two workers on the same
  operations. The same request from three processes, one idempotency key with three payloads, a
  refund and two rollbacks of one BET, a win, a loss and a second win on one BET, forty operations
  taken by two workers, two publishers over one outbox, and one of two workers killed mid-contention.
- `test/concurrency/process-crash-and-shutdown.test.ts`: a worker killed inside a transaction before
  commit, and a worker stopped with SIGTERM during a batch.

Each test asserts that exactly one operation has the effect, and that the rest are replays,
conflicts or rejections. `docs/TEST_STRATEGY.md` says which spec requirement each test proves.

To run the optional load test. It pins the stack to a number of CPUs, sends a product mix on a fixed
schedule, ramps the rate in steps, and checks every step against the constraints in
`test/load/thresholds.ts`. The generator runs on the CPUs the stack does not use:

```bash
bun run test:load                 # every CPU of the host, one run, written to docs/load/results/cpus-<N>.json
LOAD_CPUS=1 bun run test:load     # the stack on one CPU; repeat for 2, 4, ...
```

Each run writes its record, then the report `docs/LOAD_TEST_RESULTS.md` from every record in the
directory. The method is in `DECISIONS.md`, group N. The superseded runs are in `docs/LOAD_TEST_HISTORY.md`.
Pinning needs Linux.

## Tests

The layers and what each may replace are in `docs/TEST_STRATEGY.md`. In short: domain
rules are unit tested; persistence, constraints, messaging and concurrency run against
real PostgreSQL and real LocalStack, without mocks.

## Limitations

These are listed in full in `ARCHITECTURE.md` section 14. The most important:

- **API keys, not an identity provider.** Keys last until revoked, and there is no rotation or
  login. The API serves plain HTTP, so it must sit behind TLS. The design is in
  `docs/adr/0007-api-key-authentication.md`.
- **Local infrastructure only.** LocalStack stands in for SQS. No AWS deployment was made.
- **Broker-side dead-lettering** (after ten deliveries) is configured in Compose and checked on the
  provisioned queue by `test/integration/messaging/broker-redrive.test.ts`.
- **Metrics are per process**, with no aggregation or dashboard.
- **Load is measured on one cloud machine, with the stack pinned to 1, 2 and 4 CPUs.** The report gives the
  agreed rate, the CPU per request and the predicted ceiling for each count. The numbers are not a capacity
  claim for any other machine: each is for the machine that ran it, and its environment is next to it.
- The repository's Dockerfile image build could not run in the authoring sandbox, whose TLS
  proxy blocks package downloads. The stack was verified from clean volumes with an image
  built from the same source and the sandbox CA.

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
  shared/                 Money, errors, unit of work port, events, validation, observability
  shared/infrastructure/database/migrations/   versioned, reversible migrations
test/
  unit/                   domain and pure logic
  integration/            schema, persistence, use cases, messaging, faults
  concurrency/            parallel connections and three real processes
  e2e/                    HTTP
  load/                   optional load test: workload, pinning, measurement, report
docker/localstack/        queue provisioning
```
