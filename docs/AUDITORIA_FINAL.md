# Auditoria final: matriz de riscos e decisões

Esta é a Etapa zero da rodada final: o estado do repositório antes das alterações, os achados por
prioridade e o que foi feito em cada um. A matriz de requisitos continua em
[REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md); este documento registra o que foi **verificado nesta
rodada**, com o comando que o provou.

## Linha de base

Antes de qualquer alteração, em `ccr-db6e8d7e-jagf0w` (HEAD `f12191b`, árvore limpa), com PostgreSQL
17 e LocalStack 4.14 reais em containers:

| Suíte                                          | Resultado            |
| ---------------------------------------------- | -------------------- |
| `check:fast` (tipos, lint, formato, unitários) | 288 passam, 0 falham |
| `test:integration`                             | 143 passam, 0 falham |
| `test:concurrency`                             | 22 passam, 0 falham  |
| `test:e2e`                                     | 66 passam, 0 falham  |

Após a primeira fatia, `check:all` inclui `test:infra`, e o total é 288 + 4 + 143 + 22 + 66 = 523 testes, todos verdes.
A linha de base não foi alterada para acomodar os resultados: os números são os de execução.

## Matriz de riscos

Prioridades: **P0** risco à integridade financeira, segurança crítica ou requisito eliminatório. **P1**
requisito obrigatório parcial ou risco operacional relevante. **P2** melhoria de qualidade ou de
documentação. **Opcional** sem ganho demonstrável nesta rodada.

Status de validação: **Validado** (teste executado e aprovado nesta rodada), **Validado, pendente de
decisão** (comportamento provado, escolha de contrato do dono), **Aberto** (não feito), **Fora do escopo
desta rodada** (justificado abaixo).

| #   | Requisito / área                                                 | Implementação atual                                                                                       | Evidência                                                                               | Risco                                                                                                            | Prioridade                          | Decisão recomendada                                                                                | Status                                                        |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Financeiro: saldo, ledger, reversões, idempotência, concorrência | Trava pessimista por wallet, versão como guarda, constraints no banco, replay pelo estado persistido      | `check:all` verde; matriz com 156 identificadores de requisito, cada um ligado a testes | Nenhum P0 confirmado. A auditoria é por leitura e pelos testes existentes, não é uma revisão formal independente | P0 (ausente)                        | Manter; revisão adversarial independente fica como pendência                                       | Validado (suítes)                                             |
| 2   | Compose: portas publicadas                                       | PostgreSQL 5432 e LocalStack 4566 em todas as interfaces, nos dois modos; no protegido, também publicados | `docker compose config` mostrava `published` sem `host_ip`                              | Credenciais de desenvolvimento acessíveis pela rede do host                                                      | **P1**                              | Bind em `127.0.0.1`; sem porta no modo protegido                                                   | **Validado** (INF-01, INF-02, INF-03)                         |
| 3   | Autenticação: esquema `Bearer`                                   | Só `Bearer` exato, com `401` para `bearer` em minúsculas                                                  | Teste adversarial falhava antes da correção                                             | Interoperabilidade; não é brecha                                                                                 | P2                                  | RFC 9110: esquema case-insensitive                                                                 | **Validado** (AUTH-06)                                        |
| 4   | Autorização: transação por UUID de provedor alheio               | Busca o registro e só então confere o provedor: `403` para alheio, `404` para inexistente                 | `test/e2e/auth-http.test.ts` fixa o `403`; corpo do `403` sem campos                    | Oráculo de existência de UUID entre provedores. UUIDv7 limita a enumeração, mas não a elimina                    | **P1** (contrato)                   | Escopar a consulta por provedor e responder `404` para ambos. Mudança de contrato: depende do dono | **Validado, pendente de decisão** (AUTH-06, ARCHITECTURE §12) |
| 5   | Autorização: carteira por id, ledger, reconciliação, métricas    | Guard de operador antes de qualquer leitura                                                               | `authorization-adversarial.test.ts` (carteira inexistente e existente respondem igual)  | Nenhum confirmado                                                                                                | P2 (verificado)                     | Manter                                                                                             | **Validado** (AUTH-06)                                        |
| 6   | Mensageria: lote parcialmente recusado da mesma wallet           | E1 aceito, E2 recusado, E3 aceito: o publicador envia E3 antes da nova tentativa de E2                    | Leitura de `OutboxPublisher.deliver`; teste de sequência a ser escrito                  | Inversão observável no broker. Consumidores ordenam por `walletVersion`, então a garantia é esta, não FIFO       | **P1** (teste do enunciado ausente) | Provar a sequência observável; avaliar "rodadas" por agregado e comparar o custo em requisições    | Em andamento                                                  |
| 7   | Métricas do worker                                               | Contadores só na memória do processo; impressos uma vez, no encerramento                                  | `src/worker.ts` escreve o snapshot só após `runWorker` retornar                         | Métricas de DLQ, retries e lag do outbox somem se o worker morrer; nada é visto em operação                      | **P1** (requisito §10 e §12)        | Endpoint interno de métricas, não publicado no host                                                | Aberto                                                        |
| 8   | Dockerfile                                                       | Imagem roda como `root`, sem `HEALTHCHECK`                                                                | Leitura do `Dockerfile`                                                                 | Superfície maior se a imagem for comprometida                                                                    | P2                                  | `USER bun`; verificar o build com a CA da sandbox                                                  | Aberto                                                        |
| 9   | Documentação em português                                        | `README.md` em inglês; enunciado pede PT-BR como idioma principal                                         | Leitura                                                                                 | Avaliador lê em outra língua do que a exigida                                                                    | P2                                  | README em PT-BR, e `README.en.md` com o texto atual                                                | Aberto                                                        |
| 10  | Contrato OpenAPI                                                 | Inexistente; a documentação descreve os endpoints em prosa                                                | Ausência de arquivo                                                                     | Divergência não verificada entre contrato e respostas                                                            | P2                                  | Especificação escrita à mão, com teste de divergência com as rotas                                 | Aberto                                                        |
| 11  | Comparação com referências públicas                              | `docs/REFERENCE_REVIEW.md` não foi atualizado nesta rodada                                                | Não há acesso aos repositórios de referência nesta sessão (fora do escopo permitido)    | Comparação desatualizada                                                                                         | P2                                  | Atualizar numa sessão com acesso aos commits                                                       | **Fora do escopo desta rodada**                               |
| 12  | Benchmarks 1/2/4 CPUs, soak de 15–30 min, backlog                | Relatórios anteriores em `docs/LOAD_TEST_RESULTS.md`                                                      | Não reexecutados nesta rodada                                                           | Números antigos sem reprodução nesta sessão                                                                      | P2                                  | Reexecutar em ambiente descartável                                                                 | **Fora do escopo desta rodada**                               |
| 13  | Console de engenharia e laboratório de carga                     | Inexistentes                                                                                              | —                                                                                       | Escopo grande; ganho demonstrável só depois do backend estar fechado                                             | Opcional                            | Não construir nesta rodada; ver justificativa abaixo                                               | **Fora do escopo desta rodada**                               |
| 14  | Prometheus e Grafana                                             | Inexistentes                                                                                              | —                                                                                       | Sem coleta correta de workers (item 7), não há o que expor                                                       | Opcional                            | Depende do item 7; não justificado nesta rodada                                                    | **Fora do escopo desta rodada**                               |
| 15  | Vitrine pública estática                                         | Inexistente                                                                                               | —                                                                                       | Sem publicação verificada, não há URL a declarar                                                                 | P2                                  | Build estático e workflow de Pages preparados, sem declarar publicação                             | Aberto                                                        |

## Justificativas do que ficou fora

- **Console e laboratório de carga (13).** A própria especificação desta rodada diz para não iniciar o painel
  antes de os P0 estarem resolvidos, e não há P0 conhecido. Mesmo assim, o console depende de
  telemetria verdadeira (item 7), que ainda não existe. Construí-lo antes seria mostrar números que
  não são coletados. O custo de um runner seguro é alto e não está justificado para a avaliação.
- **Prometheus e Grafana (14).** Sem coleta por instância e sem métricas de worker em operação, um
  painel mostraria apenas o último snapshot de cada processo. Mantemos `/metrics` por processo, como documentado.
- **Property-based com `fast-check` (7).** Não adicionamos biblioteca: a comparação com um modelo
  de referência pode ser escrita com uma semente determinística e sem dependência, quando houver tempo.
- **Revisão de referências (11) e benchmarks (12).** Dependem de acesso e de ambiente que não foram
  verificados nesta sessão. Não declaramos nada sobre eles sem executar.

## Achado sobre a garantia de ordem (item 6)

Este item é tratado no commit próprio da mensageria, com o teste da sequência E1, E2, E3 e a comparação
entre manter o lote e reordenar por rodadas. O resultado será registrado aqui e em `ARCHITECTURE.md` §8.
