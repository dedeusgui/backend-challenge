# Índice da auditoria: onde está cada garantia

Este índice responde "onde está a prova" para cada garantia. A coluna **Prova** aponta para o arquivo de teste que a
afirma. Se o teste falha, a garantia não vale. Os números de cada linha da matriz estão em
[EDGE_CASE_MATRIX.md](EDGE_CASE_MATRIX.md), e a resposta sobre o que não foi provado está em
[FINDINGS.md](FINDINGS.md).

## Garantias, com a prova

| Garantia                                                                              | Mecanismo                                                      | Prova (arquivo de teste)                                                                                             | Matriz              |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Mesma chave e mesmo payload são um replay; payload diferente é conflito               | `findByIdentity`, `UNIQUE (provider, idempotency key)`         | `test/concurrency/three-processes.test.ts`, `test/concurrency/hot-wallet.test.ts`                                    | ID-01 a ID-06       |
| Mesmo comando por HTTP e por SQS, nas duas ordens, aplica uma vez                     | identidade da transação e da mensagem                          | `test/integration/messaging/http-and-queue-replay.test.ts`                                                           | ID-10               |
| Saldo nunca negativo; disputa pela mesma carteira aplica uma aposta                   | trava da carteira, guarda de versão, `CHECK`                   | `test/concurrency/hot-wallet.test.ts`                                                                                | TX-02               |
| Estado terminal não muda; transição inválida é recusada                               | `wager-lifecycle.ts` e guardas de linha                        | `test/unit/wagering/domain/wager-lifecycle.test.ts`, `test/integration/schema/row-guards.test.ts`                    | TX-19, FA-01        |
| Referência que chega depois da rejeição não reabre a transação                        | estado terminal; sem nova consulta                             | `test/integration/wagering/database-clock-references.test.ts`                                                        | TX-19               |
| Retenção de referência: prazo e agenda pelo relógio do banco                          | `DatabaseClock` (`now()` da unidade de trabalho)               | `test/integration/wagering/database-clock-references.test.ts`, `test/integration/wagering/pending-reference.test.ts` | PR-06               |
| Uma retenção com falha permanente vira FAILED, anunciada, e não segura as demais      | `recordFailure` no worker de referências                       | `test/integration/wagering/held-failure.test.ts`                                                                     | FA-01, F-13         |
| Backlog de retenções drena dentro do limite de tentativas                             | `MAX_REFERENCE_ATTEMPTS` e lote de 20                          | `test/integration/wagering/pending-reference-volume.test.ts`                                                         | PR-07               |
| Evento do outbox nunca se perde nem se duplica sem `eventId` estável                  | lease com token, `FOR UPDATE SKIP LOCKED`, id estável          | `test/integration/messaging/outbox-publisher.test.ts`                                                                | OB-02, OB-03, OB-05 |
| O lease é decidido pelo relógio do banco; relógio de publicador não rouba nem encurta | `now()` em `claimDue` e em `reschedule`                        | `test/integration/messaging/outbox-lease-clock.test.ts`, `test/integration/messaging/outbox-retry-clock.test.ts`     | OB-07, OB-08        |
| Envelope malformado não para a publicação dos demais                                  | `CHECK outbox_envelope_shape` e leitura que nomeia o campo     | `test/integration/messaging/outbox-malformed-row.test.ts`                                                            | OB-01               |
| Mensagem em voo não é entregue a outro consumidor enquanto o comando roda             | renovação da visibilidade, com limite de retenção              | `test/integration/messaging/slow-message-hold.test.ts`, `test/unit/messaging/application/wager-command-hold.test.ts` | QU-09               |
| Lote lento não deixa mensagens do lote visíveis a outro consumidor                    | `ChangeMessageVisibilityBatch` antes de cada mensagem seguinte | `test/integration/messaging/visibility-during-batch.test.ts`                                                         | QU-01               |
| Falha transitória não vira DLQ; falha permanente vai para a DLQ                       | `classifyCommandFailure` (em `shared/application`)             | `test/unit/wagering/domain/events-and-classification.test.ts`                                                        | QU-02, QU-03        |
| Saldo e ledger concordam na leitura, dentro da transação                              | `wallet_ledger_summary` e `summarize` na transação             | `test/integration/schema/wallet-ledger-summary.test.ts`                                                              | LG-09               |
| A concordância de saldo e ledger é garantida pelo esquema?                            | **Não**: escritas diretas são aceitas (F-06)                   | `test/experiments/ledger-agreement-triggers.test.ts` (fora do gate)                                                  | LG-04, LG-05        |
| Valores monetários são exatos; nunca `number`                                         | `Money` (decimal string)                                       | `test/unit/shared/domain/money.test.ts`                                                                              | MN-01 a MN-05       |

## Desempenho e carga

| Pergunta                                               | Onde está a resposta                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Quanto custa a renovação de visibilidade por mensagem? | **Não medido.** [PERFORMANCE_COMPARISON.md](PERFORMANCE_COMPARISON.md), experimento 2 |
| A latência do HTTP mudou nesta rodada?                 | Pares base/HEAD, sem diferença estabelecida: experimento 3                            |
| Quanto leva a drenagem de um backlog do outbox?        | Experimento 4, `docs/load/backlog/R2-backlog.txt`, `test/perf/outbox-backlog.ts`      |
| A carga se mantém por 5 minutos?                       | Experimento 5, `docs/load/soak/R2-head-100rps-300s/`                                  |
| O teto de vazão da API                                 | Não encontrado: o maior degrau testado foi 100 req/s                                  |

## Documentos desta auditoria, e para que servem

| Documento                                              | Responde                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| [FINDINGS.md](FINDINGS.md)                             | O que estava errado, a evidência, a correção e o risco que resta         |
| [EDGE_CASE_MATRIX.md](EDGE_CASE_MATRIX.md)             | Um cenário de borda por linha, com o teste que o prova e a classificação |
| [PERFORMANCE_COMPARISON.md](PERFORMANCE_COMPARISON.md) | Experimentos de desempenho, com o que foi e o que não foi medido         |
| [COVERAGE.md](COVERAGE.md)                             | Cobertura por arquivo, e o que ela não diz                               |
| [BASELINE.md](BASELINE.md)                             | Estado do repositório antes da rodada                                    |
| [DATABASE_OBJECTS.md](DATABASE_OBJECTS.md)             | Objetos de banco criados nesta rodada (guardas, views, `CHECK`)          |

As decisões que dependem do dono do desafio estão listadas no fim de [FINDINGS.md](FINDINGS.md): F-06, F-10, F-11 e
F-13 (o evento `WagerTransactionFailed`, que a especificação não lista).
