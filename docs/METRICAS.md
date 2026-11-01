Gerado por scripts/build-catalogos.ts a partir do commit c8320ea. Não edite à mão; rode `bun run docs:catalogos`.

# Catálogo de métricas

Métricas emitidas pela aplicação em `src/` e correspondência com a §12 do enunciado.

## Correspondência com a §12 do enunciado

Origem: mapeamento com os requisitos da §12 de `docs/CHALLENGE.md`. Total de requisitos: 7 (5 implementados, 2 não implementados).

| Requisito (§12)           | Status           | Métrica correspondente        |
| :------------------------ | :--------------- | :---------------------------- |
| Transações por status     | implementada     | `transactions_total`          |
| Duplicatas detectadas     | implementada     | `idempotent_replays_total`    |
| Retentativas (retries)    | não implementada | -                             |
| Mensagens em DLQ          | não implementada | -                             |
| Conflitos de lock         | implementada     | `concurrency_conflicts_total` |
| Outbox lag                | implementada     | `outbox_lag_seconds`          |
| Latência de processamento | implementada     | `processing_latency_ms`       |

## Todas as métricas da aplicação

Origem: varredura estática de `src/`. Total: 24 chamadas de métricas encontradas (23 métricas distintas).

| Métrica                            | Tipo     | Labels   | Arquivo:linha                                                                                                                                              |
| :--------------------------------- | :------- | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_ms`                          | resumo   | -        | `src/modules/auth/http/api-key.guard.ts:40`                                                                                                                |
| `commands_total`                   | contador | `result` | `src/modules/messaging/application/inbound/wager-command-consumer.ts:109`                                                                                  |
| `concurrency_conflicts_total`      | contador | -        | `src/modules/wagering/application/process-wager-transaction.use-case.ts:99`                                                                                |
| `idempotent_replays_total`         | contador | -        | `src/modules/wagering/application/process-wager-transaction.use-case.ts:249`                                                                               |
| `outbox_claim_ms`                  | resumo   | -        | `src/modules/messaging/application/outbound/outbox-publisher.ts:69`                                                                                        |
| `outbox_lag_seconds`               | resumo   | -        | `src/modules/messaging/application/outbound/outbox-publisher.ts:95`                                                                                        |
| `outbox_lost_lease_total`          | contador | -        | `src/modules/messaging/application/outbound/outbox-publisher.ts:100`                                                                                       |
| `outbox_publish_failures_total`    | contador | -        | `src/modules/messaging/application/outbound/outbox-publisher.ts:106`                                                                                       |
| `outbox_publish_ms`                | resumo   | -        | `src/modules/messaging/application/outbound/outbox-publisher.ts:81`                                                                                        |
| `outbox_published_total`           | contador | -        | `src/modules/messaging/application/outbound/outbox-publisher.ts:94`                                                                                        |
| `outbox_quarantined_total`         | contador | -        | `src/modules/messaging/application/outbound/outbox-publisher.ts:120`                                                                                       |
| `processing_latency_ms`            | resumo   | -        | `src/modules/wagering/application/process-wager-transaction.use-case.ts:91`                                                                                |
| `reconciliation_divergences_total` | contador | -        | `src/modules/wallet/application/wallet-queries.ts:87`                                                                                                      |
| `reference_exhausted_total`        | contador | -        | `src/modules/wagering/application/transaction-settlement.ts:208`                                                                                           |
| `reference_resolutions_total`      | contador | `status` | `src/modules/wagering/application/process-pending-references.use-case.ts:63`, `src/modules/wagering/application/process-pending-references.use-case.ts:89` |
| `replay_latency_ms`                | resumo   | -        | `src/modules/wagering/application/process-wager-transaction.use-case.ts:93`                                                                                |
| `request_validation_ms`            | resumo   | -        | `src/modules/wagering/http/wagering.controller.ts:66`                                                                                                      |
| `settlement_ms`                    | resumo   | -        | `src/modules/wagering/application/transaction-settlement.ts:55`                                                                                            |
| `transaction_begin_ms`             | resumo   | -        | `src/modules/wagering/application/process-wager-transaction.use-case.ts:122`                                                                               |
| `transaction_commit_ms`            | resumo   | -        | `src/modules/wagering/application/process-wager-transaction.use-case.ts:130`                                                                               |
| `transaction_work_ms`              | resumo   | -        | `src/modules/wagering/application/process-wager-transaction.use-case.ts:127`                                                                               |
| `transactions_total`               | contador | `status` | `src/modules/wagering/application/process-wager-transaction.use-case.ts:88`                                                                                |
| `wallet_lock_wait_ms`              | resumo   | -        | `src/modules/wagering/application/process-wager-transaction.use-case.ts:154`                                                                               |
