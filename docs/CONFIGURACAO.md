Gerado por scripts/build-catalogos.ts a partir do commit d2bb451. Não edite à mão; rode `bun run docs:catalogos`.

# Catálogo de configuração

Variáveis de ambiente lidas pelo código da aplicação em `src/` e definidas na composição de serviços em `docker-compose.yml`.

## Variáveis da aplicação (`src/`)

Origem: varredura estática de `src/`. Total: 20 leituras encontradas.

| Variável                      | Valor padrão                  | Regra de validação                     | Arquivo:linha                    |
| :---------------------------- | :---------------------------- | :------------------------------------- | :------------------------------- |
| `PORT`                        | `3000`                        | inteiro entre 1 e 65535                | `src/config/app-config.ts:20`    |
| `DATABASE_URL`                | -                             | obrigatória                            | `src/config/app-config.ts:21`    |
| `AWS_REGION`                  | `us-east-1`                   | obrigatória ou sem validação explícita | `src/config/app-config.ts:28`    |
| `SQS_ENDPOINT`                | -                             | obrigatória ou sem validação explícita | `src/config/app-config.ts:29`    |
| `SQS_COMMAND_QUEUE`           | `wager-transactions.fifo`     | obrigatória ou sem validação explícita | `src/config/app-config.ts:30`    |
| `SQS_COMMAND_DLQ`             | `wager-transactions-dlq.fifo` | obrigatória ou sem validação explícita | `src/config/app-config.ts:31`    |
| `SQS_EVENTS_QUEUE`            | `wager-events.fifo`           | obrigatória ou sem validação explícita | `src/config/app-config.ts:32`    |
| `SQS_REQUEST_TIMEOUT_MS`      | `5000`                        | inteiro positivo                       | `src/config/app-config.ts:35`    |
| `DATABASE_URL`                | -                             | obrigatória                            | `src/config/worker-config.ts:17` |
| `CONSUMER_VISIBILITY_SECONDS` | `30`                          | inteiro positivo                       | `src/config/worker-config.ts:24` |
| `OUTBOX_BATCH_SIZE`           | `20`                          | inteiro positivo                       | `src/config/worker-config.ts:25` |
| `OUTBOX_MAX_ATTEMPTS`         | `10`                          | inteiro positivo                       | `src/config/worker-config.ts:26` |
| `OUTBOX_RETENTION_DAYS`       | `7`                           | inteiro positivo                       | `src/config/worker-config.ts:27` |
| `OUTBOX_LEASE_MS`             | `30000`                       | inteiro positivo                       | `src/config/worker-config.ts:28` |
| `OUTBOX_IDLE_DELAY_MS`        | `500`                         | inteiro positivo                       | `src/config/worker-config.ts:29` |
| `WORKER_HTTP_PORT`            | -                             | inteiro entre 1 e 65535 (opcional)     | `src/config/worker-config.ts:30` |
| `OUTBOX_MAX_ATTEMPTS`         | `10`                          | inteiro positivo                       | `src/config/worker-config.ts:35` |
| `OUTBOX_RETENTION_DAYS`       | `7`                           | inteiro positivo                       | `src/config/worker-config.ts:39` |
| `DATABASE_URL`                | -                             | obrigatória                            | `src/migrate.ts:9`               |
| `DATABASE_URL`                | -                             | obrigatória                            | `src/auth.ts:72`                 |

## Variáveis do Compose (`docker-compose.yml`)

Origem: `docker-compose.yml`. Total: 18 variáveis encontradas.

| Variável                | Valor padrão                                            | Regra de validação     | Arquivo:linha           |
| :---------------------- | :------------------------------------------------------ | :--------------------- | :---------------------- |
| `DATABASE_URL`          | `postgresql://wagering:wagering@postgres:5432/wagering` | definida na composição | `docker-compose.yml:10` |
| `AWS_REGION`            | `us-east-1`                                             | definida na composição | `docker-compose.yml:11` |
| `AWS_ACCESS_KEY_ID`     | `test`                                                  | definida na composição | `docker-compose.yml:12` |
| `AWS_SECRET_ACCESS_KEY` | `test`                                                  | definida na composição | `docker-compose.yml:13` |
| `SQS_ENDPOINT`          | `http://localstack:4566`                                | definida na composição | `docker-compose.yml:14` |
| `SQS_COMMAND_QUEUE`     | `wager-transactions.fifo`                               | definida na composição | `docker-compose.yml:15` |
| `SQS_COMMAND_DLQ`       | `wager-transactions-dlq.fifo`                           | definida na composição | `docker-compose.yml:16` |
| `SQS_EVENTS_QUEUE`      | `wager-events.fifo`                                     | definida na composição | `docker-compose.yml:17` |
| `POSTGRES_USER`         | `wagering`                                              | definida na composição | `docker-compose.yml:23` |
| `POSTGRES_PASSWORD`     | `wagering`                                              | definida na composição | `docker-compose.yml:24` |
| `POSTGRES_DB`           | `wagering`                                              | definida na composição | `docker-compose.yml:25` |
| `PUBLISH_HOST`          | `127.0.0.1`                                             | opcional com fallback  | `docker-compose.yml:27` |
| `SERVICES`              | `sqs`                                                   | definida na composição | `docker-compose.yml:39` |
| `AWS_DEFAULT_REGION`    | `us-east-1`                                             | definida na composição | `docker-compose.yml:40` |
| `PUBLISH_HOST`          | `127.0.0.1`                                             | opcional com fallback  | `docker-compose.yml:42` |
| `PORT`                  | `3000`                                                  | definida na composição | `docker-compose.yml:64` |
| `PUBLISH_HOST`          | `127.0.0.1`                                             | opcional com fallback  | `docker-compose.yml:66` |
| `WORKER_HTTP_PORT`      | `3001`                                                  | definida na composição | `docker-compose.yml:93` |
