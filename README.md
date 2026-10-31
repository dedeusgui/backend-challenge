# Distributed Wagering Processor

Implementation of the [Jungle Gaming backend challenge](https://github.com/junglegaming/backend-challenge).
The [original challenge specification](docs/CHALLENGE.md) is preserved verbatim.

> **Current status: foundation only.** The HTTP process boots and exposes liveness.
> Financial endpoints, persistence entities/migrations, SQS consumption/publication,
> readiness, and concurrency tests are **not implemented yet**.

## Stack

Bun 1.x · TypeScript strict · NestJS · PostgreSQL · MikroORM · AWS SQS (LocalStack) · Docker Compose.

## Run locally

Requirements: Bun 1.x and Docker with Compose.

```bash
cp .env.example .env
bun install
docker compose up -d postgres localstack
bun run dev
```

Check the currently implemented endpoint:

```bash
curl http://localhost:3000/health/live
# {"status":"ok"}
```

Alternatively, start all infrastructure and the minimal API together:

```bash
docker compose up --build
```

The Compose stack creates PostgreSQL and three SQS queues:
`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, and
`wager-events.fifo`. The first two form the inbound command queue and DLQ;
the last queue will eventually receive committed integration events.

### Developer commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Restart-on-change HTTP entrypoint |
| `bun run start` | Start HTTP process |
| `bun run typecheck` | Check strict TypeScript types |
| `bun run test:unit` | Run implemented Bun unit tests |
| `bun run test` | Run all currently available Bun tests |
| `bun run format:check` | Validate formatting |
| `docker compose down` | Stop containers (preserve database volume) |

The lockfile has **not** been generated as part of the scaffold. Run
`bun install` with the intended Bun 1.x version and commit the resulting
`bun.lock` before claiming reproducible installs or introducing frozen CI builds.
Never commit `.env` or actual credentials.

## Layout

```text
src/
  main.ts                  # HTTP bootstrap
  app.module.ts            # minimal Nest module
  health/                  # liveness (implemented)
  modules/
    wallet/                # aggregate, ledger and reconciliation (planned)
    wagering/              # transaction lifecycle and use cases (planned)
    messaging/             # Inbox, Outbox and SQS adapters (planned)
  shared/
    domain/                # shared Money value object (planned)
    application/ports/     # provider identity extension port
    infrastructure/        # cross-module persistence boundary (planned)
test/
  unit/                    # liveness smoke test
  integration/             # PostgreSQL + LocalStack (planned)
  concurrency/             # real multi-process tests (planned)
docker/localstack/          # queue provisioning
```

See [module boundaries](src/modules/README.md), [architecture and decisions](ARCHITECTURE.md),
[implementation checklist](docs/IMPLEMENTATION_PLAN.md), and
[public implementation review](docs/REFERENCE_REVIEW.md).

## Delivery scope

Planned HTTP endpoints: `POST /wallets`, `GET /wallets/:walletId`,
`GET /wallets/:walletId/ledger`, `GET /wagering/transactions/:transactionId`,
`GET /providers/:providerId/wagering/transactions/:externalTransactionId`,
`POST /wagering/transactions`, `POST /wallets/:walletId/reconciliation`,
`GET /health/live`, and `GET /health/ready`.

Planned operations: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`;
`OPENING` must remain internal. Both HTTP and SQS will use one application
use case. The PostgreSQL transaction will atomically persist wallet, wager,
ledger, inbox (if applicable) and outbox.

See the [original README](docs/CHALLENGE.md) for authoritative behavior,
evaluation criteria, required test scenarios, and event contracts.

## Integrity and limitations

Do not treat the current bootstrap as a complete submission.
The only implemented route is `/health/live`. It **does not** prove database
or queue readiness. Authentication is intentionally not implemented in this
foundation, as permitted by the challenge when documented.
