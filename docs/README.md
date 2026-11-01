# Índice da documentação

Este é o ponto central da documentação do **Distributed Wagering Processor**. Os documentos estão em português (pt-BR).
Nomes de arquivos, comandos, identificadores, campos JSON e trechos de código permanecem como estão no código.

Para verificar a solução em cerca de 40 minutos, comece pelo [README](../README.md) e siga o
[guia do avaliador](REVIEWER_GUIDE.md).

## Ordem de leitura

1. [README](../README.md): como rodar a stack, a demonstração e as suítes de teste.
2. [Guia do avaliador](REVIEWER_GUIDE.md): roteiro de verificação, com o que cada teste prova e o que não prova.
3. [Matriz de requisitos](REQUIREMENTS_MATRIX.md): cada requisito ligado ao teste que o prova.
4. [Arquitetura](../ARCHITECTURE.md): fluxos e decisões principais, com a tabela de decisões no início.
5. [Glossário do domínio](DOMAIN_GLOSSARY.md): os termos do domínio e seus nomes no código.
6. [Contrato HTTP](openapi.json): o contrato OpenAPI, verificado contra as rotas reais.

## Perguntas do avaliador

Use esta tabela quando já souber o que procura. Cada resposta aponta para um único lugar.

| Pergunta                                                                | Onde responder                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Como rodar a solução e a demonstração?                                  | [README](../README.md), seção "Como rodar"                                                                                                                                           |
| Quais comandos existem, e o que cada um faz?                            | [README](../README.md), seções "Testes" e "Outros comandos"                                                                                                                          |
| Há PostgreSQL e SQS reais, ou só mocks?                                 | [Estratégia de testes](TEST_STRATEGY.md), seção "Suítes e comandos"                                                                                                                  |
| Quais são as decisões, os trade-offs e as limitações?                   | [Arquitetura](../ARCHITECTURE.md), tabela "Principais decisões" e seções 13 e 14                                                                                                     |
| Onde está a idempotência?                                               | [Arquitetura](../ARCHITECTURE.md), seção 6                                                                                                                                           |
| Como o saldo fica não negativo sob concorrência?                        | [Arquitetura](../ARCHITECTURE.md), seção 5                                                                                                                                           |
| Como o evento só é publicado depois do commit?                          | [Arquitetura](../ARCHITECTURE.md), seção 8                                                                                                                                           |
| Como as referências fora de ordem são tratadas, e qual é o limite?      | [Arquitetura](../ARCHITECTURE.md), seção 9                                                                                                                                           |
| Quais são as falhas eliminatórias, e onde está a prova de cada uma?     | [Matriz de requisitos](REQUIREMENTS_MATRIX.md), seção de eliminatórias (§14)                                                                                                         |
| Qual é o contrato HTTP?                                                 | [OpenAPI](openapi.json) e [Arquitetura](../ARCHITECTURE.md), seção 10                                                                                                                |
| Qual capacidade foi medida, e com quais ressalvas?                      | [README](../README.md), seção "Evidências de desempenho". Detalhes: [baseline de nuvem](LOAD_TEST_RESULTS.md) (em inglês) e [baseline local](LOAD_TEST_BASELINE.md), com 13 cenários |
| Quais são os dois baselines de carga, e em qual ambiente cada um rodou? | [README](../README.md), seção "Dois baselines, dois ambientes"; e [baseline local](LOAD_TEST_BASELINE.md), seção "Dois baselines, dois ambientes"                                    |
| Quais decisões dependem do dono do desafio?                             | [Auditoria final, §4](AUDITORIA_FINAL.md) e [achados](audit/FINDINGS.md), seção "Decisões que precisam do dono do desafio"                                                           |

**Leitura principal:** README, Arquitetura e Guia do avaliador. Os demais são consulta. Apêndices e históricos
(plano de implementação, histórico de carga, revisões de invariantes e de referências, auditoria final) registram como
o projeto chegou aqui, e não precisam ser lidos para avaliar a solução.

**Versões em inglês:** cada documento principal tem uma versão de referência em inglês, com o sufixo `.en.md`, como
[README.en.md](../README.en.md) e [ARCHITECTURE.en.md](../ARCHITECTURE.en.md). O conteúdo é o mesmo.

## Documentos por assunto

| Assunto                 | Documento                                                                                                                                                                                                                                 | Conteúdo                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Entrada                 | [README](../README.md)                                                                                                                                                                                                                    | Visão geral, como rodar, testar e demonstrar                                       |
| Enunciado               | [Desafio](CHALLENGE.md)                                                                                                                                                                                                                   | Enunciado original do desafio, cópia fiel                                          |
| Glossário               | [Glossário do domínio](DOMAIN_GLOSSARY.md)                                                                                                                                                                                                | Termos do domínio e seus nomes no código                                           |
| Arquitetura             | [Arquitetura](../ARCHITECTURE.md)                                                                                                                                                                                                         | Fluxos, decisões principais e limitações (seção 14)                                |
| Decisões                | [Decisões](../DECISIONS.md)                                                                                                                                                                                                               | Índice consolidado das 141 decisões, agrupadas por tema, com a prova de cada grupo |
| Registros de decisão    | [ADRs](adr/README.md)                                                                                                                                                                                                                     | ADRs 0001 a 0007, com contexto, alternativas e consequências                       |
| Requisitos              | [Matriz de requisitos](REQUIREMENTS_MATRIX.md)                                                                                                                                                                                            | Requisito, teste que o prova e estado (`PASSING` só depois que a suíte passa)      |
| Estratégia de testes    | [Estratégia de testes](TEST_STRATEGY.md)                                                                                                                                                                                                  | O que cada suíte executa e o que ela não substitui                                 |
| Fluxos                  | [Matriz de fluxos](FLOW_MATRIX.md)                                                                                                                                                                                                        | Tabela de respostas por resultado e grafos dos fluxos HTTP e da fila               |
| Invariantes             | [Revisão de invariantes](INVARIANT_REVIEW.md)                                                                                                                                                                                             | Invariantes, restrições do banco e decisões que dependem do dono do desafio        |
| Auditoria final         | [Auditoria final](AUDITORIA_FINAL.md)                                                                                                                                                                                                     | Situação de cada item da matriz de riscos, decisões do dono e pendências reais     |
| Auditoria               | [Índice da auditoria](audit/README.md)                                                                                                                                                                                                    | Onde está a prova de cada garantia, achados, cobertura e comparações de desempenho |
| Carga                   | [Resultados de carga](LOAD_TEST_RESULTS.md), [baseline local](LOAD_TEST_BASELINE.md) e [histórico de carga](LOAD_TEST_HISTORY.md)                                                                                                         | Resultados da nuvem, baseline local com 13 cenários e o histórico das rodadas      |
| Plano de implementação  | [Plano de implementação](IMPLEMENTATION_PLAN.md)                                                                                                                                                                                          | Apêndice: registro das fatias implementadas                                        |
| Módulos                 | [Fronteiras dos módulos](../src/modules/README.md)                                                                                                                                                                                        | O que cada módulo possui e o que não pode fazer                                    |
| Contrato HTTP           | [OpenAPI](openapi.json)                                                                                                                                                                                                                   | Contrato da API, verificado contra as rotas                                        |
| Diagramas               | [Diagramas](diagrams/)                                                                                                                                                                                                                    | Diagramas SVG usados no README e na matriz de fluxos                               |
| Convenções              | [Convenções da documentação](CONVENCOES_DOCUMENTACAO.md)                                                                                                                                                                                  | Idioma, pares em inglês, arquivos gerados e como mudar a documentação              |
| Instruções para agentes | [CLAUDE.md](../CLAUDE.md)                                                                                                                                                                                                                 | Regras do projeto para agentes de código (mantido em inglês)                       |
| Runbooks para agentes   | [financeiro](runbooks/financial-change.md), [concorrência](runbooks/concurrency-debugging.md), [mensageria](runbooks/messaging-recovery.md), [migrações](runbooks/database-migration.md), [revisão](runbooks/code-review-verification.md) | Procedimentos focados por tipo de mudança, cada um com referência em inglês        |

## Arquivos gerados

Estes arquivos são produzidos por ferramentas. Não edite à mão, porque a próxima execução sobrescreve o conteúdo:

- [`LOAD_TEST_RESULTS.md`](LOAD_TEST_RESULTS.md): gerado por `test/load/report.ts` a partir de `docs/load/results/`.
- `docs/load/`, `docs/edge/results/` e `docs/audit/perf/`: medições brutas em JSON, produzidas pelos testes de carga e de desempenho.
