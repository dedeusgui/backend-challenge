# Cobertura de código

Medida do estado `71e245a` (com a documentação desta rodada). Ferramenta: `bun test` com `--coverage`, relatório
lcov, sobre as suítes em processo (`test/unit`, `test/integration`, `test/e2e`, `test/infra`).

## Números

| Medida                                      | Antes desta rodada                  | Agora                                    |
| ------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| Linhas de `src/` (93 arquivos)              | 96,31% (3107 de 3226)               | **99,13%** (3198 de 3226)                |
| Funções de `src/`                           | —                                   | **99,27%** (409 de 412)                  |
| Arquivos de `src/` abaixo de 95% de linhas  | 19                                  | **0**                                    |
| Testes passando (todas as suítes com banco) | 653 (unit, integration, e2e, infra) | 796 em processo, mais 23 de concorrência |

A medida anterior de todos os arquivos (incluindo `test/`), obtida com o relatório de texto, era 95,59% das linhas
e 97,44% das funções. A medida de `src/` é a que vale para o produto.

## O que a cobertura de linha não mede

- **Os processos separados.** A suíte de concorrência sobe workers em processos filhos, que saem com código 137 em
  pontos precisos, e a cobertura do Bun não acompanha processos filhos. O código que esses workers executam
  (consumo, publicação, referências pendentes) é coberto pelo comportamento, não pela linha. As suítes que
  provam isso são `test/concurrency` (23 casos) e `test/integration/model` (8 casos com sementes: cinco em série e três com
  quatro aplicações simultâneas).
- **Caminhos de falha da infraestrutura.** O LocalStack recusa uma requisição inteira em vez de recusar uma
  entrada por vez, então o ramo que lê a recusa por entrada não roda contra ele.
- **Defesas.** Os `throw` marcados como invariantes (por exemplo, uma mensagem interna sem fingerprint) não são
  alcançáveis pelo fluxo normal. Eles existem para que um estado impossível falhe alto.

## Linhas que ficaram de fora

| Arquivo                                                                         | Cobertas | Linhas descobertas | Motivo |
| ------------------------------------------------------------------------------- | -------- | ------------------ | ------ |
| `src/modules/messaging/infrastructure/sqs/sqs-queue.ts`                         | 100/104  | 66, 67, 68, 86     |
| `src/modules/messaging/infrastructure/mikro-orm-outbox.store.ts`                | 47/49    | 94, 103            |
| `src/modules/wagering/application/process-wager-transaction.use-case.ts`        | 185/187  | 253, 265           |
| `src/modules/wagering/http/wagering.controller.ts`                              | 74/76    | 101, 102           |
| `src/modules/wallet/application/wallet-queries.ts`                              | 54/56    | 73, 98             |
| `src/worker/worker-http.ts`                                                     | 38/40    | 59, 60             |
| `src/config/worker-config.ts`                                                   | 34/35    | 58                 |
| `src/modules/auth/infrastructure/mikro-orm-api-client.repository.ts`            | 29/30    | 40                 |
| `src/modules/messaging/infrastructure/mikro-orm-inbox.repository.ts`            | 35/36    | 45                 |
| `src/modules/messaging/infrastructure/mikro-orm-outbox.repository.ts`           | 24/25    | 12                 |
| `src/modules/messaging/infrastructure/sqs/sqs-event-transport.ts`               | 37/38    | 78                 |
| `src/modules/wagering/application/process-pending-references.use-case.ts`       | 34/35    | 45                 |
| `src/modules/wagering/application/wager-command-fields.ts`                      | 37/38    | 75                 |
| `src/modules/wagering/infrastructure/mikro-orm-wager-transaction.repository.ts` | 114/115  | 36                 |
| `src/modules/wallet/application/ledger-cursor.ts`                               | 19/20    | 28                 |
| `src/modules/wallet/application/open-wallet.use-case.ts`                        | 81/82    | 33                 |
| `src/modules/wallet/domain/events/wallet-balance-changed.event.ts`              | 23/24    | 32                 |
| `src/modules/wallet/infrastructure/mikro-orm-wallet-ledger.repository.ts`       | 74/75    | 73                 |
| `src/modules/wallet/infrastructure/mikro-orm-wallet.repository.ts`              | 63/64    | 50                 |
| `src/shared/observability/metrics.ts`                                           | 30/31    | 48                 |

Os ramos de recusa por entrada de `sqs-queue.ts` (linhas 66 a 68 e 86) são os descritos acima. As demais linhas
são defensivas ou de leitura de configuração que os testes de integração já exercitam por outro caminho.

## Como reproduzir

```bash
bun test test/unit test/integration test/e2e test/infra --coverage --coverage-reporter=lcov --coverage-dir /tmp/cov
```

Depois, somar as linhas `DA:` por arquivo sob `src/` no `lcov.info`. A soma não está versionada: são poucas linhas,
e o relatório bruto é reproduzível pelo comando acima.

## Metas

O pedido desta rodada era uma base de cerca de 95% sobre todos os fluxos. A base por linha está acima disso e
nenhum arquivo do produto está abaixo. A parte que a linha não mede (os processos, a infraestrutura real e as
sequências aleatórias) está coberta pelas suítes citadas acima, e é a parte que mais pesa para a resiliência.
