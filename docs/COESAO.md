# Análise de coesão a partir do histórico de mudanças

## 1. Pergunta e resposta curta

**Pergunta do projeto:** Há arquivos de 2 linhas ao lado de arquivos de 600. Qual é a coesão disso, e o que podemos fazer para o código ser mais coeso?

**Conclusão:**
Coesão neste contexto afere se os elementos de um arquivo mudam juntos pelo mesmo motivo e se arquivos pequenos delimitam fronteiras reais de arquitetura. Os arquivos pequenos (2 a 9 linhas) são portas de aplicação, tokens de injeção e contratos de domínio compartilhados que isolam responsabilidades e devem ser mantidos separados. A extensão excessiva de linhas concentra-se em 24 arquivos com mais de 300 linhas (22 deles em testes e ferramentas de carga), dos quais 4 suítes misturam responsabilidades independentes e devem ser divididas.

## 2. Como foi medido

Todos os comandos foram executados a partir da raiz do repositório no commit HEAD.

### Contagem de linhas e faixas de tamanho

Contagem sobre todos os arquivos rastreados em `src/` e `test/`:

```bash
git ls-files src test | xargs wc -l
```

Resultado total: 33,111 linhas distribuídas em 277 arquivos rastreados.

Distribuição por faixas de tamanho (todos os arquivos rastreados):

- Arquivos com até 10 linhas:

```bash
git ls-files src test | xargs wc -l | awk '$1 <= 10 && $2 != "total"'
```

Resultado: 21 arquivos (5 arquivos TypeScript, 1 arquivo de documentação Markdown e 15 arquivos `.gitkeep` com 0 linhas).

- Arquivos de 11 a 50 linhas:

```bash
git ls-files src test | xargs wc -l | awk '$1 >= 11 && $1 <= 50 && $2 != "total"'
```

Resultado: 81 arquivos.

- Arquivos com mais de 300 linhas:

```bash
git ls-files src test | xargs wc -l | awk '$1 > 300 && $2 != "total"'
```

Resultado: 24 arquivos.

Distribuição restrita a código TypeScript (`.ts`):

- Total de arquivos `.ts`:

```bash
git ls-files src test | grep '\.ts$' | wc -l
```

Resultado: 256 arquivos.

- Arquivos `.ts` com até 10 linhas:

```bash
git ls-files src test | grep '\.ts$' | xargs wc -l | awk '$1 <= 10 && $2 != "total"'
```

Resultado: 5 arquivos.

- Arquivos `.ts` de 11 a 50 linhas:

```bash
git ls-files src test | grep '\.ts$' | xargs wc -l | awk '$1 >= 11 && $1 <= 50 && $2 != "total"'
```

Resultado: 79 arquivos.

- Arquivos `.ts` com mais de 300 linhas:

```bash
git ls-files src test | grep '\.ts$' | xargs wc -l | awk '$1 > 300 && $2 != "total"'
```

Resultado: 24 arquivos (2 em `src/` e 22 em `test/`).

### Histórico de co-mudanças no git

Comando para extração de commits no HEAD:

```bash
git log --no-merges --name-only --format='@@%h|%s'
```

Critério de filtragem:

- Descarte de commits de merge (`--no-merges`).
- Descarte de commits cujo assunto inicia por `docs` ou cujos arquivos alterados pertencem exclusivamente a `docs/` e `package.json`.
- Conjunto considerado: 113 commits com alterações em arquivos de `src/` e `test/`.
- Para cada par de arquivos tocados no mesmo commit, computa-se a frequência de co-mudanças. Pares com 3 ou mais commits conjuntos foram avaliados quanto a acoplamento entre módulos.

## 3. Tabela de arquivos pequenos (até 10 linhas)

| Arquivo                                                        | Linhas | Parceiro mais forte                                             | Co-mudanças | Recomendação                                                                                                                      |
| :------------------------------------------------------------- | :----- | :-------------------------------------------------------------- | :---------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/infrastructure/sqs/sqs.tokens.ts`                  | 2      | `src/app.module.ts`                                             | 1 (isolado) | MANTER SEPARADO: Ponto de composição do Nest para injeção de dependência dos clientes SQS sem expor implementações concretas.     |
| `src/shared/domain/ledger-direction.ts`                        | 3      | `src/modules/wagering/domain/failure-code.ts`                   | 2 (isolado) | MANTER SEPARADO: Contrato de domínio compartilhado entre módulos para impedir acoplamento direto entre carteira e apostas.        |
| `src/modules/messaging/application/ports/inbox-repository.ts`  | 6      | `src/modules/auth/application/authenticate-api-key.use-case.ts` | 1 (isolado) | MANTER SEPARADO: Porta hexagonal que desacopla a camada de aplicação da infraestrutura de desduplicação de mensagens.             |
| `src/shared/application/ports/database-clock.ts`               | 8      | `src/modules/auth/application/authenticate-api-key.use-case.ts` | 1 (isolado) | MANTER SEPARADO: Porta de aplicação que abstrai a leitura do relógio do banco de dados sem dependência de driver de persistência. |
| `src/modules/messaging/application/ports/outbox-repository.ts` | 9      | `src/modules/auth/application/authenticate-api-key.use-case.ts` | 1 (isolado) | MANTER SEPARADO: Porta hexagonal para enfileiramento transacional de eventos de integração na unidade de trabalho.                |

_Nota:_ `src/modules/README.md` (10 linhas) é um documento explicativo das fronteiras modulares e os 15 arquivos `.gitkeep` (0 linhas) são marcadores estruturais do git, todos mantidos separados.

## 4. Tabela de arquivos grandes (mais de 300 linhas)

| Arquivo                                                                  | Linhas | Motivos de mudança                                                                                             | Recomendação                                                                                                                             |
| :----------------------------------------------------------------------- | :----- | :------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `test/load/load-test.ts`                                                 | 951    | Orquestração do teste de carga, fixação de CPU via cpuset/taskset e amostragem de latência.                    | MANTER: Roteiro único de execução de carga.                                                                                              |
| `test/integration/wagering/process-wager-transaction.test.ts`            | 926    | Validação de integração do caso de uso de processar aposta com PostgreSQL real.                                | MANTER: Suíte coesa espelhando o caso de uso principal.                                                                                  |
| `test/integration/schema/schema-constraints.test.ts`                     | 840    | Três domínios independentes: regras de carteiras, apostas e mensageria no banco.                               | DIVIDIR: Separar em `wallet-schema-constraints.test.ts`, `wagering-schema-constraints.test.ts` e `messaging-schema-constraints.test.ts`. |
| `test/features/steps/mensageria.steps.ts`                                | 670    | Dois assuntos distintos: consumo de filas SQS/DLQ e resolução assíncrona de referências.                       | DIVIDIR: Separar em `mensageria-consumer.steps.ts` e `reference-worker.steps.ts`.                                                        |
| `test/features/steps/finance-edge.steps.ts`                              | 644    | Quatro assuntos: tipos monetários, estouro numérico, concorrência de reversões e gatilhos de integridade.      | DIVIDIR: Separar em `money.steps.ts`, `settlement-edge.steps.ts` e `row-guards.steps.ts`.                                                |
| `test/concurrency/distributed-contention.test.ts`                        | 541    | Cenários de contenção de saldo distribuída entre processos concorrentes.                                       | MANTER: Foco único em validação de concorrência real.                                                                                    |
| `test/integration/messaging/outbox-publisher.test.ts`                    | 505    | Ciclo de publicação em lote e renovação de leases na outbox.                                                   | MANTER: Suíte focada no publicador transacional.                                                                                         |
| `test/unit/wagering/domain/wager-transaction.test.ts`                    | 502    | Regras de transição de estado e validação da entidade de aposta.                                               | MANTER: Suíte unitária coesa com a entidade de domínio.                                                                                  |
| `test/load/report.ts`                                                    | 491    | Duas responsabilidades: formatação de relatórios Markdown e persistência em disco de arquivos JSON de rodadas. | DIVIDIR: Separar em `test/load/report-renderer.ts` e `test/load/run-store.ts`.                                                           |
| `src/modules/wagering/domain/wager-transaction.ts`                       | 397    | Invariantes de ciclo de vida e regras de negócio da transação de aposta.                                       | MANTER: Raiz de agregado com alta coesão interna; métodos operam estritamente sobre o estado da entidade.                                |
| `test/integration/model/random-sequences.test.ts`                        | 394    | Testes baseados em propriedades com sequências pseudoaleatórias de operações.                                  | MANTER: Propósito único de teste gerador de modelo.                                                                                      |
| `test/features/steps/mensageria-outbox.steps.ts`                         | 392    | Definições de passos Gherkin para o ciclo de publicação da outbox.                                             | MANTER: Foco único no comportamento da outbox.                                                                                           |
| `test/integration/messaging/wager-command-consumer.test.ts`              | 391    | Testes de integração do consumidor SQS de comandos.                                                            | MANTER: Suíte dedicada ao consumidor de mensagens.                                                                                       |
| `test/integration/faults/fault-injection.test.ts`                        | 368    | Injeção de falhas controladas e recuperação transacional.                                                      | MANTER: Suíte especializada em resiliência.                                                                                              |
| `test/integration/wagering/pending-reference.test.ts`                    | 361    | Ciclo de retenção e reprocessamento de apostas com referência externa ausente.                                 | MANTER: Suíte focada no fluxo de referências não resolvidas.                                                                             |
| `test/e2e/authorization-adversarial.test.ts`                             | 350    | Cenários de ataque e conformidade de autorização HTTP com API keys.                                            | MANTER: Suíte de segurança com foco único.                                                                                               |
| `test/integration/messaging/duplicate-deliveries.test.ts`                | 341    | Idempotência e tolerância a entregas duplicadas na mensageria.                                                 | MANTER: Suíte focada em garantias de entrega.                                                                                            |
| `test/edge/protected-mode.test.ts`                                       | 325    | Regras de limitação de taxa e cabeçalhos no proxy de borda Nginx.                                              | MANTER: Suíte dedicada à camada de borda.                                                                                                |
| `test/e2e/openapi-responses.test.ts`                                     | 325    | Conformidade de contratos e respostas com a especificação OpenAPI.                                             | MANTER: Validação contratual de API.                                                                                                     |
| `src/modules/wagering/application/process-wager-transaction.use-case.ts` | 324    | Orquestração do caso de uso de processamento de aposta (idempotência, bloqueio e liquidação).                  | MANTER: Caso de uso com fluxo único de execução; métodos privados auxiliam exclusivamente a cadeia de processamento.                     |
| `test/e2e/input-contract-http.test.ts`                                   | 323    | Validação de entradas e rejeição de payloads malformados via HTTP.                                             | MANTER: Suíte dedicada aos contratos de entrada.                                                                                         |
| `test/integration/schema/row-guards.test.ts`                             | 320    | Validação de gatilhos PostgreSQL para proteção e imutabilidade dos lançamentos contábeis.                      | MANTER: Suíte especializada em integridade de banco.                                                                                     |
| `test/concurrency/three-processes.test.ts`                               | 307    | Verificação de integridade financeira sob contenção com três processos em paralelo.                            | MANTER: Suíte focada em contenção distribuída.                                                                                           |
| `test/load/workload.ts`                                                  | 303    | Geração de mix sintético de operações para teste de carga.                                                     | MANTER: Módulo coeso de geração de carga.                                                                                                |

## 5. Pares entre módulos com acoplamento (sinal ruim)

| Par de arquivos                                                                                                                                         | Co-mudanças | Leitura da evidência                                                                                                                                                                                                              |
| :------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/wagering/http/wagering.controller.ts` <br> `src/modules/wallet/http/wallet.controller.ts`                                                  | 4           | Controladores de módulos de negócio distintos alterados simultaneamente para introduzir autenticação por API key e padronizar erros 400. Evidencia evolução dispersa de regras HTTP antes da unificação de interceptores globais. |
| `src/modules/wagering/http/wagering.controller.ts` <br> `src/shared/http/error-response.ts`                                                             | 4           | O controlador de apostas foi adaptado repetidamente a cada alteração na estrutura e códigos de erro da camada HTTP compartilhada.                                                                                                 |
| `src/modules/wallet/http/wallet.controller.ts` <br> `src/shared/http/error-response.ts`                                                                 | 3           | Mesmo acoplamento observado no controlador de apostas, causado pela evolução síncrona dos formatos de resposta de erro HTTP.                                                                                                      |
| `src/app.module.ts` <br> `src/modules/wagering/http/wagering.controller.ts`                                                                             | 4           | Centralização de composição no módulo raiz do NestJS, exigindo alteração no arquivo central a cada nova rota ou dependência de controlador.                                                                                       |
| `src/modules/messaging/infrastructure/mikro-orm-inbox.repository.ts` <br> `src/modules/wagering/application/process-wager-transaction.use-case.ts`      | 3           | O caso de uso de apostas orquestra diretamente a persistência da tabela de mensagens recebidas (`inbox`) dentro da unidade de trabalho financeira.                                                                                |
| `src/modules/wagering/infrastructure/mikro-orm-wager-transaction.repository.ts` <br> `src/modules/wallet/infrastructure/mikro-orm-wallet.repository.ts` | 3           | Repositórios de domínios distintos evoluídos juntos durante ajustes de bloqueio pessimista e controle de concorrência com a unidade de trabalho compartilhada.                                                                    |
| `src/worker/worker-runtime.ts` <br> `src/modules/wagering/application/process-wager-transaction.use-case.ts`                                            | 3           | Ponto de entrada do worker ajustado em conjunto com a orquestração dos casos de uso para execução fora do ciclo HTTP.                                                                                                             |
| `test/integration/schema/schema-constraints.test.ts` <br> `src/modules/wagering/domain/wager-transaction.ts`                                            | 3           | Suíte de testes de schema monolítica que acumula regras de tabelas de múltiplos módulos, quebrando o isolamento de testes entre domínios.                                                                                         |
| `test/integration/faults/fault-injection.test.ts` <br> `test/integration/messaging/outbox-publisher.test.ts`                                            | 5           | Suítes de integração acopladas por alterações simultâneas em ganchos de teste e no relógio de leases da outbox.                                                                                                                   |

## 6. O que não foi verificado: limites do método

- **Histórico curto:** O repositório conta com 175 commits totais (113 avaliados após exclusão de documentação e merges). Arquivos pequenos foram introduzidos em momentos específicos de organização modular e tiveram pouca rotação de commits, gerando a classificação de 'isolado' por escassez temporal e não por desuso.
- **Commits de fatia vertical:** A prática de entregar incrementos completos em um único commit reúne código, testes e documentação. Isso produz co-mudanças temporais entre arquivos de módulos distintos sem que exista dependência lógica direta entre eles.
- **Acoplamento estático por imports:** A co-mudança analisa apenas o histórico de alterações no git. O grafo estático de dependências de tipos foi verificado separadamente através dos testes de fronteira em [boundaries.test.ts](../test/unit/architecture/boundaries.test.ts).
- **Refatorações estruturais em lote:** Commits de reorganização de pastas alteraram dezenas de arquivos de uma só vez, gerando contagens pontuais de co-mudança sem configurar acoplamento conceitual permanente.
