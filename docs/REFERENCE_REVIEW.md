# Revisão de implementações públicas

> **Apêndice.** Uma comparação com três implementações públicas, elaborada para avaliar o design. A execução ou teste do
> serviço não depende deste documento.

Revisado em 2026-10-31 por meio da leitura dos três repositórios públicos (clones rasos
no branch padrão), busca via grep em seus códigos e leitura de seus documentos de
arquitetura. As suítes de referência **não foram executadas**, portanto nenhuma afirmação aqui se baseia em
seus resultados de teste. Esses projetos servem de referência para trade-offs. Nada foi
copiado deles.

Cada observação abaixo cita o arquivo que lhe dá suporte. Afirmações que não puderam ser
verificadas estão listadas ao final e não foram utilizadas em nenhuma decisão.

## 1. AndreLopes30/junglegaming-backend-challenge

- **Bloqueio (Locking):** a carteira é lida com `LockMode.PESSIMISTIC_WRITE`
  (`src/infrastructure/persistence/repositories/wallet.repository.ts`). A reivindicação da outbox
  utiliza `PESSIMISTIC_PARTIAL_WRITE`, que equivale a `FOR UPDATE SKIP LOCKED`
  (`outbox.repository.ts`).
- **Dinheiro:** o domínio mantém unidades fracionárias em `bigint` (`src/domain/money/money.ts`).
  A persistência armazena `numeric` como string, convertida com `replace('.', '')`.
- **Outbox durante E/S (I/O):** o documento de arquitetura afirma que a outbox mantém um
  lock de linha e uma conexão aberta enquanto chama o SQS (seção 15). Este design
  troca simplicidade por transações longas. Nós não o adotamos.
- **Pontos de entrada:** `src/main.ts` e `src/worker.ts` são separados. O documento
  afirma que nenhum ponto de entrada executa migrações.
- **Reconciliação:** documentada apenas como diagnóstica; nunca corrige saldo nem
  incrementa versão. Adotamos a mesma regra.
- **Métricas:** contadores por processo, com DLQ e lag lidos da infraestrutura
  compartilhada. Indicado como uma limitação.
- **Autenticação:** um guard no-op como ponto de extensão. Mesma decisão que a nossa.

## 2. paulovitorlr/jungle-gaming-challenge

- **Controle de versão otimista:** o reprocessador de referências pendentes lê
  `wallet.version` e chama `walletRepository.update(wallet, expectedVersion)`
  (`src/modules/wagering/application/use-cases/reprocess-pending-references.use-case.ts`).
  A carteira não é bloqueada de forma pessimista nesse fluxo.
- **Leases:** o publicador da outbox assume um lease com duração configurada
  (`src/modules/messaging/infrastructure/outbox/outbox-publisher.service.ts`), e as
  reivindicações usam `FOR UPDATE SKIP LOCKED`. O envio ocorre fora da transação
  de reivindicação. Este é o design que adotamos.
- **Mapeadores (Mappers):** arquivos explícitos de mapper existem para cada entidade de persistência
  (`wager-transaction.mapper.ts`, `wallet.mapper.ts`).
- **Dinheiro:** objeto de valor baseado em `decimal.js` (`src/shared/domain/value-objects/money.vo.ts`),
  com colunas `numeric(20, 2)`. Isso coincide com a nossa escolha.

## 3. eriksonwilliam/jungle-gaming-wagering

- **Bloqueio (Locking):** `LockMode.PESSIMISTIC_WRITE` na carteira
  (`src/infrastructure/persistence/mikro-orm/repositories/wallet.repository.ts`),
  e `PESSIMISTIC_PARTIAL_WRITE` na outbox.
- **Dinheiro:** unidades fracionárias em `bigint` nos repositórios de ledger e wager, através de
  `toMinorUnits()` e `BigInt(...)`.
- **Operações:** verificador JWT e guard do Keycloak, adaptador de métricas Prometheus
  e painel do Grafana estão presentes. O desafio não concede pontuação para esses itens.
  Não os adotamos, conforme `docs/REFERENCE_REVIEW.md` havia recomendado anteriormente.

## O que isso mudou em nossas decisões

- **Lock de carteira:** os três usam lock de linha pessimista. Nossas próprias evidências de
  mutação acrescentam um fato que eles não estabelecem: sem o lock de linha, a proteção por versão
  ainda impede corrupção, mas uma carteira disputada (hot wallet) esgota suas retentativas sob
  carga (`test/concurrency/hot-wallet.test.ts`). O lock é mantido por
  disponibilidade, não apenas por corretude. Consulte `docs/adr/0001-pessimistic-wallet-lock.md`.
- **Representação de dinheiro:** duas referências utilizam unidades fracionárias no domínio. Nós utilizamos
  `decimal.js` com `NUMERIC(20,2)`, conforme decidido no documento de arquitetura. Unidades
  fracionárias são uma representação exata mais simples para moedas de duas casas decimais, e
  reconsideraríamos a escolha se o domínio crescesse além disso. Registrado em
  `docs/adr/0002-money-representation.md`.
- **E/S (I/O) da Outbox:** mantemos o envio fora de qualquer transação, seguindo
  `paulovitorlr`. O design de envio dentro da transação em `AndreLopes30` é
  rejeitado: ele mantém uma conexão e um lock de linha durante toda a chamada ao broker.
- **Reconciliação:** apenas diagnóstica, assim como em `AndreLopes30`.

## Consulta sobre testes e o que podemos estar esquecendo

Relido nesta rodada, confrontando com as suítes de teste dos três repositórios. A questão era saber se
os requisitos de teste do desafio (seção 13) e o cenário de concorrência (seção 8) estão totalmente
cobertos aqui, e o que as outras implementações testam que nós não testamos.

| Área                                              | O que a referência faz                                                                                                                                                                                                                                                                                                  | O que este projeto faz                                                                                                                                                                                         | Decisão                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Mesma operação a partir de vários processos       | andre: `test/integration/multi-process-concurrency.test.ts` (três processos HTTP, estado mantido entre reinícios). paulo: `test/concurrency/multiprocess-concurrency.spec.ts` (carteira disputada entre processos independentes). erikson: `duplicate-bet.concurrency.test.ts` (cinquenta BETs paralelas, um processo). | `test/concurrency/three-processes.test.ts` e `distributed-contention.test.ts`: processos reais, uma chave de idempotência com três payloads, reversões e resultados concorrentes, verificação de lock perdido. | Adotado, e estendido além das referências.                                                                        |
| "Multi-instância"                                 | A suíte de paulo afirma "Three application contexts in one process". As instâncias de erikson rodam em um processo só (sem `spawn` na suíte).                                                                                                                                                                           | Processos reais apenas.                                                                                                                                                                                        | Nossas suítes são mais robustas aqui. Registrado para que a afirmação não seja repetida como prova.               |
| Dois publicadores sobre uma outbox                | erikson: `outbox-publishers.concurrency.test.ts`, em um processo contra PostgreSQL real.                                                                                                                                                                                                                                | Em um processo, e agora através de dois processos de worker com contagem de leases perdidos (`distributed-contention.test.ts`).                                                                                | Adotado entre processos.                                                                                          |
| Vários workers em uma carteira                    | Não testado por nenhuma das três referências.                                                                                                                                                                                                                                                                           | `distributed-contention.test.ts`: dois workers, quarenta operações em uma carteira e um worker encerrado no meio da contenção.                                                                                 | Adicionado aqui.                                                                                                  |
| Teste de carga                                    | erikson: `test/load/run.ts`, contra nginx e três instâncias, com tokens Keycloak, p95 por cenário.                                                                                                                                                                                                                      | `bun run test:load`: três processos e dois workers, p50, p95 e p99 do lado do cliente, lag da outbox e o invariante após a execução. Grava `docs/LOAD_TEST_RESULTS.md`.                                        | Adotado no nosso formato. Não está em `check:all`.                                                                |
| Painéis e exportação de métricas                  | erikson: Prometheus e Grafana provisionados por Compose, com configuração de scrape para cada instância.                                                                                                                                                                                                                | JSON em `GET /metrics` por processo, sem agregação.                                                                                                                                                            | Não adotado. O desafio não o exige. É o primeiro candidato caso a observabilidade seja revista.                   |
| Identidade                                        | erikson: Keycloak, o provedor de identidade sugerido pelo desafio.                                                                                                                                                                                                                                                      | Chaves de API com dois papéis (ADR 0007).                                                                                                                                                                      | Desvio deliberado. Decisão D5 do proprietário em `INVARIANT_REVIEW.md`.                                           |
| Cobertura                                         | erikson: script `test:coverage`.                                                                                                                                                                                                                                                                                        | Nenhuma.                                                                                                                                                                                                       | Candidato. Cobertura nada diz sobre o entrelaçamento que importa aqui, não sendo barreira de validação.           |
| Testes de mutação                                 | Nenhuma das três.                                                                                                                                                                                                                                                                                                       | Mutantes manuais, registrados em `TEST_STRATEGY.md`, quatro nesta rodada.                                                                                                                                      | Nenhuma ferramenta adicionada. O registro manual mantém-se transparente com o único sobrevivente (`SKIP LOCKED`). |
| Teste de fumaça (smoke test) de stack em execução | andre: script `infra:check` (`check-infrastructure.ts`), que verifica a stack antes dos testes.                                                                                                                                                                                                                         | `/health/ready` apenas, checado manualmente.                                                                                                                                                                   | Candidato: um script que envie uma BET para uma stack Compose em execução.                                        |
| Testes unitários com dublês de teste              | erikson: `test/unit/application/use-cases/*` com fakes.                                                                                                                                                                                                                                                                 | Testes unitários usam objetos de domínio reais, e nenhum fake para banco de dados ou fila.                                                                                                                     | Mantido. Alinha-se à regra de não substituir o banco de dados nem a fila.                                         |
| Reinício e ponto de entrada de worker             | paulo: `restart-recovery.e2e.spec.ts`. andre: `worker-entrypoint.test.ts`.                                                                                                                                                                                                                                              | `three-processes.test.ts` (reinício, SIGTERM) e `process-crash-and-shutdown.test.ts` (kill antes de commit, SIGTERM durante lote).                                                                             | Coberto.                                                                                                          |
| Restrições                                        | paulo: `database-constraints.e2e.spec.ts`. erikson: `schema-constraints.integration.test.ts`.                                                                                                                                                                                                                           | `test/integration/schema/schema-constraints.test.ts`, 38 declarações de teste, cada probe falhando antes de sua migração existir.                                                                              | Coberto.                                                                                                          |

### O que ainda podemos estar deixando passar

1. **Um processo de API encerrado dentro de uma transação.** Nenhuma referência testa isso também. O caminho HTTP é
   coberto em processo e por retentativa de provedor sob a mesma chave.
2. **Um teste de fumaça (smoke test) da stack Compose em execução**, o equivalente ao `infra:check` do andre.
3. **Números de cobertura**, que as referências publicam e nós não.
4. **Métricas legíveis por um dashboard**, como erikson provisiona.
5. **A espera pelo lock de carteira**, que nenhuma referência mede também. Este projeto não a
   mede. `concurrency_conflicts_total` conta apenas disputas perdidas.

## Não verificado, não utilizado

- Contagem de testes e status de sucesso ou falha das suítes de referência.
- A alegação de `paulovitorlr` sobre "algumas entidades sob uma área compartilhada genérica", feita na
  revisão anterior sem evidências.
- Qualquer comportamento sob concorrência ou falha no código de referência. Não o
  executamos, portanto nenhuma conclusão sobre corretude é extraída.
