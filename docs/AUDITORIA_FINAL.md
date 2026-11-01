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

| #   | Requisito / área                                                                                                                                        | Implementação atual                                                                                       | Evidência                                                                               | Risco                                                                                                            | Prioridade                                                                          | Decisão recomendada                                                                                     | Status                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Financeiro: saldo, ledger, reversões, idempotência, concorrência                                                                                        | Trava pessimista por wallet, versão como guarda, constraints no banco, replay pelo estado persistido      | `check:all` verde; matriz com 148 identificadores de requisito, cada um ligado a testes | Nenhum P0 confirmado. A auditoria é por leitura e pelos testes existentes, não é uma revisão formal independente | P0 (ausente)                                                                        | Manter; revisão adversarial independente fica como pendência                                            | Validado (suítes)                                                        |
| 2   | Compose: portas publicadas                                                                                                                              | PostgreSQL 5432 e LocalStack 4566 em todas as interfaces, nos dois modos; no protegido, também publicados | `docker compose config` mostrava `published` sem `host_ip`                              | Credenciais de desenvolvimento acessíveis pela rede do host                                                      | **P1**                                                                              | Bind em `127.0.0.1`; sem porta no modo protegido                                                        | **Validado** (INF-01, INF-02, INF-03)                                    |
| 3   | Autenticação: esquema `Bearer`                                                                                                                          | Só `Bearer` exato, com `401` para `bearer` em minúsculas                                                  | Teste adversarial falhava antes da correção                                             | Interoperabilidade; não é brecha                                                                                 | P2                                                                                  | RFC 9110: esquema case-insensitive                                                                      | **Validado** (AUTH-06)                                                   |
| 4   | Busca o registro e só então confere o provedor. Até a rodada de auditoria: `403` para alheio, `404` para inexistente. Desde `154b52a`: `404` para ambos | `test/e2e/authorization-adversarial.test.ts` (resposta igual para alheio e inexistente)                   | `test/e2e/auth-http.test.ts` fixa o `403`; corpo do `403` sem campos                    | Oráculo de existência de UUID entre provedores. UUIDv7 limita a enumeração, mas não a elimina                    | **P1** (contrato)                                                                   | Escopar a consulta por provedor e responder `404` para ambos. Mudança de contrato: depende do dono      | **Validado, pendente de decisão** (AUTH-06, ARCHITECTURE §12)            |
| 5   | Autorização: carteira por id, ledger, reconciliação, métricas                                                                                           | Guard de operador antes de qualquer leitura                                                               | `authorization-adversarial.test.ts` (carteira inexistente e existente respondem igual)  | Nenhum confirmado                                                                                                | P2 (verificado)                                                                     | Manter                                                                                                  | **Validado** (AUTH-06)                                                   |
| 6   | Mensageria: lote parcialmente recusado da mesma wallet                                                                                                  | E1 aceito, E2 recusado, E3 aceito: o publicador envia E3 antes da nova tentativa de E2                    | Leitura de `OutboxPublisher.deliver`; teste de sequência a ser escrito                  | Inversão observável no broker. Consumidores ordenam por `walletVersion`, então a garantia é esta, não FIFO       | **P1** (teste do enunciado ausente)                                                 | Provar a sequência observável; avaliar "rodadas" por agregado e comparar o custo em requisições         | Em andamento                                                             |
| 7   | Métricas do worker                                                                                                                                      | Contadores só na memória do processo; impressos uma vez, no encerramento                                  | `src/worker.ts` escreve o snapshot só após `runWorker` retornar                         | Métricas de DLQ, retries e lag do outbox somem se o worker morrer; nada é visto em operação                      | **P1** (requisito §10 e §12)                                                        | Endpoint interno de métricas, não publicado no host                                                     | Aberto                                                                   |
| 8   | Dockerfile                                                                                                                                              | Imagem roda como `root`, sem `HEALTHCHECK`                                                                | Leitura do `Dockerfile`                                                                 | Superfície maior se a imagem for comprometida                                                                    | P2                                                                                  | `USER bun`; verificar o build com a CA da sandbox                                                       | Aberto                                                                   |
| 9   | Documentação em português (escolha desta rodada)                                                                                                        | `README.md` em inglês até esta rodada                                                                     | O enunciado não exige idioma: a escolha foi desta rodada                                | P2                                                                                                               | Manter a documentação principal em português, e o texto em inglês em `README.en.md` | **Validado** (README.md e README.en.md)                                                                 |
| 10  | Contrato OpenAPI                                                                                                                                        | Inexistente antes; agora `docs/openapi.json`, com 10 operações                                            | `openapi-contract.test.ts`, `openapi-responses.test.ts`                                 | Divergência entre contrato e respostas. A verificação achou uma: `seq` é texto, não inteiro                      | P2                                                                                  | Contrato escrito à mão, verificado contra as rotas e as respostas                                       | **Validado** (DOC-01 a DOC-04)                                           |
| 11  | Comparação com referências públicas                                                                                                                     | `docs/REFERENCE_REVIEW.md` não foi atualizado nesta rodada                                                | Não há acesso aos repositórios de referência nesta sessão (fora do escopo permitido)    | Comparação desatualizada                                                                                         | P2                                                                                  | Atualizar numa sessão com acesso aos commits                                                            | **Fora do escopo desta rodada**                                          |
| 12  | Benchmarks 1/2/4 CPUs, soak de 15–30 min, backlog                                                                                                       | Relatórios anteriores em `docs/LOAD_TEST_RESULTS.md`                                                      | Não reexecutados nesta rodada                                                           | Números antigos sem reprodução nesta sessão                                                                      | P2                                                                                  | Reexecutar em ambiente descartável                                                                      | **Fora do escopo desta rodada**                                          |
| 13  | Console de engenharia e laboratório de carga                                                                                                            | Inexistentes                                                                                              | —                                                                                       | Escopo grande; ganho demonstrável só depois do backend estar fechado                                             | Opcional                                                                            | Não construir nesta rodada; ver justificativa abaixo                                                    | **Fora do escopo desta rodada**                                          |
| 14  | Prometheus e Grafana                                                                                                                                    | Inexistentes                                                                                              | —                                                                                       | Sem coleta correta de workers (item 7), não há o que expor                                                       | Opcional                                                                            | Depende do item 7; não justificado nesta rodada                                                         | **Fora do escopo desta rodada**                                          |
| 15  | Vitrine pública estática                                                                                                                                | Gerador de uma página, a partir de arquivos do repositório; workflow do GitHub Pages                      | `static-showcase.test.ts`: 10 casos                                                     | Publicação sem verificação: a URL não existe até a configuração do repositório                                   | P2                                                                                  | Publicar só depois da fonte "GitHub Actions" ser habilitada, e verificar a URL real antes de declará-la | **Validado** o build (SHW-01, SHW-02); **BLOCKED** a publicação (SHW-03) |

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

Com E2 recusado na primeira requisição, o broker real recebe `walletVersion` 1 e 3 e depois 2, e o
outbox guarda E2 sozinho, com uma tentativa, até o fim do backoff. A garantia para o consumidor é:
todo evento chega (tentativas sem teto), `eventId` identifica o fato, e `walletVersion` ordena as
alterações de saldo de uma wallet. O consumidor precisa aplicar `last + 1` e segurar as versões
maiores. O texto completo está em ARCHITECTURE §8.

A alternativa de enviar em rodadas, uma entrada por wallet em cada requisição, foi avaliada e não foi
adotada: não cobre dois publicadores, e em carteiras quentes multiplica as requisições por até o
tamanho do lote. Nenhum tempo de execução foi medido para ela, e a conclusão se baseia na contagem de
requisições, que é determinística.

## Correção desta rodada: CI, benchmark, documentação e Pages

Esta seção registra o que estava errado na entrega anterior, o que foi corrigido e o que cada correção
provou. Cada validação cita o commit do código e a execução que a provou. Um commit de documentação posterior
não muda o código validado.

### Erros encontrados e corrigidos

| Erro                                                                   | Causa                                                                                                                                          | Correção                                                                                                                                               | Commit    | Prova                                                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI do `828822e` falhou com `fatal: ambiguous argument 'f12191b..HEAD'` | O job `checks` usava checkout raso, sem o commit-base da vitrine. O teste da vitrine falhou no `beforeAll`, e o gate parou antes da integração | `fetch-depth: 0` no job `checks`. Sem fallback: a ausência da base continua falhando                                                                   | `a34ff4d` | Clone raso reproduz a falha. Clone completo passa (10 de 10). CI `41250517354`: `checks` e `image` verdes                                             |
| Respostas inesperadas não reprovavam um degrau                         | `unexpected` era calculado e reportado, mas não entrava nos motivos                                                                            | Juízo por requisição (`test/load/judgement.ts`): correta, concorrente ou incorreta. Uma incorreta reprova o degrau, com limite zero                    | `f4e3dfe` | 24 casos de regra e de motivo em `test/unit/load/judgement.test.ts`. Degraus aprovados históricos continuam aprovados (`historical-verdicts.test.ts`) |
| Verificação de duplicidade com escopo errado                           | `GROUP BY external_transaction_id` sozinho. A identidade real é por provedor, e dois provedores com o mesmo id davam falso positivo            | Auditoria por `(provider_id, external_transaction_id)`, `(provider_id, idempotency_key)` e transações com mais de um lançamento (`test/load/audit.ts`) | `5f80bfb` | 7 casos contra PostgreSQL em `test/integration/load/duplicate-audit.test.ts`, incluindo o caso que o escopo antigo reprovava                          |
| Outbox lag com unidade trocada e fora do relatório                     | `outbox_lag_seconds` gravado com os campos `meanMs` e `maxMs`, e o relatório não renderizava as fases                                          | A unidade vem do nome da métrica. A seção "Latency, lag and drain" separa latência HTTP, atraso do gerador, drenagem e outbox lag                      | `5cf454c` | `test/unit/load/phases.test.ts` (9 casos). Relatório regenerado a partir dos três registros; nenhum registro foi alterado                             |
| Documentação dizia que PT-BR era exigência do enunciado                | Redação da própria auditoria                                                                                                                   | O idioma é escolha desta rodada. O enunciado não exige idioma                                                                                          | `472f436` | Linha 9 da matriz de riscos e `README.en.md`                                                                                                          |
| Matriz com limites antigos (25, 100 e 200)                             | LOAD-01 não acompanhou a campanha medida em `b34c198`                                                                                          | Matriz com 100, 200 e 400 req/s, com o histórico de 25/100/200 referenciado                                                                            | `472f436` | Commit de origem dos registros confirmado: `b34c198`                                                                                                  |
| Vitrine com contagens sem origem verificável                           | `gate-results.json` apontava para um commit antigo                                                                                             | As contagens vêm da execução de CI do commit `af998ff`, com o link da execução                                                                         | `c115149` | `static-showcase.test.ts`: o link da execução é checado e o repositório precisa ser o deste projeto                                                   |

### Validado pela CI no commit de código `af998ff`

Execução `41251559996` (https://github.com/dedeusgui/backend-challenge/actions/runs/41251559996):

- job `checks`: sucesso, com o gate completo rodando no runner do GitHub. Contagens: 362 unitários, 4 de
  infraestrutura, 151 de integração, 23 de concorrência e 100 e2e, todos com zero falhas.
- job `image`: sucesso. O Dockerfile do repositório foi construído pelo GitHub, o que a sandbox não consegue.

Essas contagens estão em `docs/site/gate-results.json`, e a vitrine as mostra com o link desta execução.

### Benchmark: o que cada número é

- **Latência HTTP**: o tempo que o cliente espera pela resposta, p50, p95 e p99 do degrau acordado. Medida a
  partir do horário agendado de envio.
- **Atraso do gerador**: quão tarde o gerador enviou cada requisição. O p99 é comparado com o limite de 50 ms.
- **Outbox lag**: tempo entre o commit de um evento e o envio dele à fila, medido pelo worker por evento, sobre
  todo o run. Tem contagem, média e máximo. Não há percentil, porque o worker não mantém histograma. Está em
  segundos.
- **Drenagem da Outbox**: tempo, após o fim de um degrau, até nenhum evento ficar sem publicar. Em segundos.
- **Taxas acordadas dos registros commitados**: 100, 200 e 400 req/s em 1, 2 e 4 CPUs. Os registros são de
  `b34c198`. O julgamento atual foi reaplicado a eles, e os degraus aprovados continuam aprovados.

### Smoke de carga no HEAD da correção

Um smoke de 1 CPU, em `5cf454c`, com degraus de 10 e 25 req/s e 5 s cada. Os dois passaram, com 175 requisições
enviadas e nenhuma perdida, nenhuma incorreta e nenhuma duplicidade. O registro está em
`docs/load/smoke/5cf454c/cpus-1.json`, e fica separado dos resultados commitados. Não é uma campanha: não
substitui a campanha de `b34c198`.

### Pendências reais

- **Campanha completa no código atual.** Não reexecutada. O código de medição mudou depois de `b34c198`. O que
  foi validado é a regra (testes), a reaplicação aos registros antigos e o smoke, não uma campanha nova.
- **Soak de 15–30 min, teste de backlog, comparação com as referências públicas e revisão adversarial
  independente.** Não feitos nesta rodada, pelo mesmo motivo da seção anterior.
- **Console de engenharia, laboratório de carga, Prometheus e Grafana.** Não construídos. Ver "Não
  implementado, com motivo" abaixo.
- **Build da imagem a partir do repositório, nesta sandbox.** Não é possível aqui. A CI o faz.

### Não implementado, com motivo

| Item                                            | Motivo                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Console de engenharia e laboratório de carga    | Dependem de telemetria verdadeira em operação. A superfície do worker foi criada nesta rodada, e um console agora mostraria pouco.    |
| Prometheus e Grafana                            | Sem coleta por instância validada em execução, um painel mostraria apenas snapshots.                                                  |
| `fast-check`                                    | A biblioteca não traria prova além dos testes existentes.                                                                             |
| Troca de `403` por `404` na transação alheia    | Aplicada na rodada de auditoria (`154b52a`). Aguarda confirmação do dono do contrato; ARCHITECTURE §12 e docs/audit/FINDINGS.md F-03. |
| Alternativa de publicação por rodadas no outbox | Avaliada por contagem de requisições e não adotada. Ver a seção de mensageria.                                                        |
| Atualização de `docs/REFERENCE_REVIEW.md`       | Os repositórios de referência ficam fora do escopo desta sessão.                                                                      |

## Rodada de auditoria adversarial

A rodada que seguiu esta auditoria está em `docs/audit/`: linha de base (`BASELINE.md`), matriz de casos de borda
com classificação por evidência (`EDGE_CASE_MATRIX.md`), defeitos e decisões (`FINDINGS.md`) e experimentos com
medição (`PERFORMANCE_COMPARISON.md`). Ela corrigiu quatro defeitos demonstrados, e deixou três decisões para o
dono do desafio.
