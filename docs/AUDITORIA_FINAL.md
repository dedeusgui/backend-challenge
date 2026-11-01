# Auditoria final

Resumo da auditoria da entrega: o que foi verificado e com que comando, a situação de cada item da matriz de riscos
desta rodada, o que está aberto e o que depende do dono do desafio. Os detalhes estão nos documentos linkados.

**Código auditado:** `2e55a9c`. Depois dele, a rodada final mudou só documentação e o texto gerado do relatório de
carga da nuvem (`test/load/report.ts`).

## 1. Como foi verificado

| Verificação                           | Como                                                               | Resultado                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Gate completo                         | `bun run check:all`                                                | 484 unitários, 4 de infraestrutura, 235 de integração, 23 de concorrência e 100 e2e, sem falhas                     |
| Carga local, 13 cenários              | `bun run test:load` e `bun run load:consolidate`                   | Zero requisições perdidas, incorretas e violações no passo acordado: [LOAD_TEST_BASELINE.md](LOAD_TEST_BASELINE.md) |
| Carga na nuvem, 1, 2 e 4 CPUs         | registros de execução do commit `b34c198`                          | Taxas acordadas de 100, 200 e 400 req/s: [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md)                               |
| Implementações públicas de referência | leitura de três repositórios; as suítes delas não foram executadas | [REFERENCE_REVIEW.md](REFERENCE_REVIEW.md)                                                                          |
| Auditoria adversarial                 | casos de borda, experimentos e defeitos                            | [audit/](audit/README.md): 15 achados, F-01 a F-15                                                                  |
| Vitrine publicada                     | `GET https://dedeusgui.github.io/backend-challenge/`               | HTTP 200, em 2026-11-01                                                                                             |

A CI do GitHub também roda o gate no commit `af998ff`: 362 unitários, 4 de infraestrutura, 151 de integração, 23 de
concorrência e 100 e2e, com a imagem construída pelo próprio GitHub. A sandbox não consegue construir a imagem.

## 2. Situação dos itens da matriz de riscos

A matriz de riscos desta rodada tinha 15 itens. A situação de cada um, hoje:

| #   | Item                                                     | Situação                                                                                                                     | Prova                                                                                        |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Financeiro: saldo, ledger, reversões, idempotência       | Validado pelas suítes. Não houve revisão independente por pessoa de fora                                                     | `check:all`; [REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md)                                |
| 2   | Portas publicadas do Compose                             | Validado: todas as portas publicadas ligam em `127.0.0.1`, e o modo protegido não publica a API                              | `test/infra`; INF-01 a INF-03                                                                |
| 3   | Esquema `Bearer` sem diferenciar maiúsculas              | Validado                                                                                                                     | AUTH-06                                                                                      |
| 4   | Transação de outro provedor, `403` ou `404`              | Corrigido em `154b52a`: `404` para ambos. A troca de contrato aguarda o dono (F-03)                                          | `test/e2e/authorization-adversarial.test.ts`                                                 |
| 5   | Autorização de carteira, ledger, reconciliação, métricas | Validado                                                                                                                     | AUTH-06                                                                                      |
| 6   | Ordem de envio no outbox com lote parcialmente recusado  | Validado. Garantia: o consumidor ordena por `walletVersion`, não por FIFO. Ver [ARCHITECTURE.md §8](../ARCHITECTURE.md)      | `test/integration/messaging/partial-batch-order.test.ts`                                     |
| 7   | Métricas do worker só ao encerrar                        | Corrigido em `ebb3e84`: o worker expõe `/metrics` e a saúde numa porta interna, não publicada                                | `test/unit/worker/worker-http.test.ts`, `test/concurrency/worker-metrics-live.test.ts`       |
| 8   | Imagem Docker como `root`                                | Corrigido em `a03d8de`: a imagem roda como `bun`. O build foi verificado no CI, não na sandbox                               | Execução `41251559996`                                                                       |
| 9   | Documentação em português                                | Validado. O português é a versão principal; o inglês é a referência                                                          | `README.md`, `README.en.md`                                                                  |
| 10  | Contrato OpenAPI                                         | Validado: `docs/openapi.json` é conferido contra as rotas e contra as respostas reais                                        | `test/unit/openapi/openapi-contract.test.ts`, `test/e2e/openapi-responses.test.ts`           |
| 11  | Comparação com referências públicas                      | Feita por leitura, em [REFERENCE_REVIEW.md](REFERENCE_REVIEW.md). As suítes delas não foram executadas                       | Leitura dos repositórios                                                                     |
| 12  | Benchmarks, soak e backlog                               | **Parcial.** Campanhas local (13 cenários) e na nuvem (1, 2 e 4 CPUs) feitas. Soak de 15 a 30 minutos e teste de backlog não | [LOAD_TEST_BASELINE.md](LOAD_TEST_BASELINE.md), [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md) |
| 13  | Console de engenharia e laboratório de carga             | Não construído, pelo motivo da seção 5                                                                                       | —                                                                                            |
| 14  | Prometheus e Grafana                                     | Não construídos, pelo motivo da seção 5                                                                                      | —                                                                                            |
| 15  | Vitrine estática pública                                 | Publicada: a URL responde HTTP 200 (verificado em 2026-11-01)                                                                | `test/unit/site/static-showcase.test.ts`, GitHub Pages                                       |

## 3. Achados da auditoria adversarial

A rodada em [audit/](audit/README.md) encontrou 15 achados. O estado de cada um está em
[audit/FINDINGS.md](audit/FINDINGS.md). Resumo:

- **Corrigidos, ou endurecidos sem reprodução (10):** F-01, F-02, F-03 (com a troca de contrato pendente), F-04, F-05,
  F-07, F-08, F-13 (com confirmação pendente), F-14 e F-15.
- **Aberto, com decisão proposta (1):** F-06, a concordância entre saldo e ledger não é garantida pelo esquema.
- **Documentado ou monitorado (2):** F-09 (plano de consulta do ledger, a acompanhar com `EXPLAIN`) e F-11 (resultado
  sem referência).
- **Contornado para a demonstração (1):** F-12, a imagem Docker não constrói na sandbox.
- **Comportamento fixado em teste, aguardando o dono (1):** F-10, o `ROLLBACK` do BET depois do `ROLLBACK` do REFUND.

## 4. Decisões que dependem do dono do desafio

Cada item é uma escolha de contrato, não um defeito de implementação. O código segue a proposta até a confirmação.

- **F-03:** a transação de outro provedor responde `404`, igual à inexistente. Aplicado; confirmar.
- **F-06:** aceitar que escritas diretas no banco contornem a concordância entre saldo e ledger, ou criar uma
  verificação no esquema. Aberto.
- **F-10:** recusar o `ROLLBACK` do BET depois do `ROLLBACK` do REFUND. Fixado em teste; confirmar.
- **F-13:** a retenção com falha permanente vira `FAILED`, anunciada, sem travar as demais. Confirmar.
- **D1 a D5:** interpretações do enunciado, em [INVARIANT_REVIEW.md](INVARIANT_REVIEW.md) e
  [ARCHITECTURE.md §13](../ARCHITECTURE.md).

## 5. Pendências reais e o que ficou de fora

**Pendências:**

- Soak de 15 a 30 minutos e teste de backlog de carga: não feitos.
- Campanha no código final: a nuvem foi medida no código de `b34c198`, e a local no código atual. Não há
  campanha de nuvem no código final.
- Revisão adversarial por pessoa de fora: não feita. A rodada de [audit/](audit/README.md) foi conduzida pela própria
  sessão de desenvolvimento.
- Construção da imagem a partir do repositório: só no CI (`af998ff`), não na sandbox.

**Fora do escopo, com motivo:**

- **Console de engenharia e laboratório de carga.** Dependem de telemetria em operação. O worker expõe agora seus
  contadores, mas ainda não há coleta por instância validada; um console mostraria pouco.
- **Prometheus e Grafana.** Mesmo motivo. O §12 do enunciado pede métricas de transações por status, duplicatas,
  retries, DLQ, conflitos de lock, outbox lag e latência. O código emite todas elas em `/metrics`, por processo e sem
  agregação: `transactions_total`, `idempotent_replays_total`, `commands_total` (com `RETRY` e `DEAD`),
  `concurrency_conflicts_total`, `wallet_lock_wait_ms`, `outbox_lag_seconds` e `processing_latency_ms`. Um painel que
  agregue os processos é o passo seguinte, e não é exigido.
- **`fast-check`.** A biblioteca não traria prova além das suítes existentes, que comparam com um modelo de
  referência.

A próxima rodada é de qualidade de código, conforme combinado com o dono.

## 6. Correções rastreáveis

| Commit    | O que corrigiu                                                                          | Prova                                                                 |
| --------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `a34ff4d` | CI com checkout raso, que quebrava o teste da vitrine                                   | Clone raso reproduz a falha; a CI `41250517354` passa                 |
| `f4e3dfe` | Respostas inesperadas não reprovavam um degrau de carga                                 | `test/unit/load/judgement.test.ts`; `historical-verdicts.test.ts`     |
| `5f80bfb` | Auditoria de duplicatas com escopo errado, por `external_transaction_id` sozinho        | `test/integration/load/duplicate-audit.test.ts`                       |
| `5cf454c` | Unidade do lag do outbox trocada, e fases fora do relatório                             | `test/unit/load/phases.test.ts`                                       |
| `472f436` | Idioma de documentação apresentado como exigência, e limites antigos na matriz de carga | Linha 9 da matriz; `README.en.md`                                     |
| `c115149` | Contagens da vitrine sem origem verificável                                             | `static-showcase.test.ts`: o link da execução de CI é checado         |
| `154b52a` | `403` revelava a existência de transação de outro provedor                              | `test/e2e/authorization-adversarial.test.ts`                          |
| `a03d8de` | Imagem da API rodando como `root`                                                       | Dockerfile com `USER bun`                                             |
| `ebb3e84` | Métricas do worker só impressas ao encerrar                                             | Superfície interna do worker; `/metrics` na porta 3001, não publicada |
