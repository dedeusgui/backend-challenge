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

| #   | Requisito / área                                                 | Implementação atual                                                                                       | Evidência                                                                               | Risco                                                                                                            | Prioridade                          | Decisão recomendada                                                                                     | Status                                                                   |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Financeiro: saldo, ledger, reversões, idempotência, concorrência | Trava pessimista por wallet, versão como guarda, constraints no banco, replay pelo estado persistido      | `check:all` verde; matriz com 148 identificadores de requisito, cada um ligado a testes | Nenhum P0 confirmado. A auditoria é por leitura e pelos testes existentes, não é uma revisão formal independente | P0 (ausente)                        | Manter; revisão adversarial independente fica como pendência                                            | Validado (suítes)                                                        |
| 2   | Compose: portas publicadas                                       | PostgreSQL 5432 e LocalStack 4566 em todas as interfaces, nos dois modos; no protegido, também publicados | `docker compose config` mostrava `published` sem `host_ip`                              | Credenciais de desenvolvimento acessíveis pela rede do host                                                      | **P1**                              | Bind em `127.0.0.1`; sem porta no modo protegido                                                        | **Validado** (INF-01, INF-02, INF-03)                                    |
| 3   | Autenticação: esquema `Bearer`                                   | Só `Bearer` exato, com `401` para `bearer` em minúsculas                                                  | Teste adversarial falhava antes da correção                                             | Interoperabilidade; não é brecha                                                                                 | P2                                  | RFC 9110: esquema case-insensitive                                                                      | **Validado** (AUTH-06)                                                   |
| 4   | Autorização: transação por UUID de provedor alheio               | Busca o registro e só então confere o provedor: `403` para alheio, `404` para inexistente                 | `test/e2e/auth-http.test.ts` fixa o `403`; corpo do `403` sem campos                    | Oráculo de existência de UUID entre provedores. UUIDv7 limita a enumeração, mas não a elimina                    | **P1** (contrato)                   | Escopar a consulta por provedor e responder `404` para ambos. Mudança de contrato: depende do dono      | **Validado, pendente de decisão** (AUTH-06, ARCHITECTURE §12)            |
| 5   | Autorização: carteira por id, ledger, reconciliação, métricas    | Guard de operador antes de qualquer leitura                                                               | `authorization-adversarial.test.ts` (carteira inexistente e existente respondem igual)  | Nenhum confirmado                                                                                                | P2 (verificado)                     | Manter                                                                                                  | **Validado** (AUTH-06)                                                   |
| 6   | Mensageria: lote parcialmente recusado da mesma wallet           | E1 aceito, E2 recusado, E3 aceito: o publicador envia E3 antes da nova tentativa de E2                    | Leitura de `OutboxPublisher.deliver`; teste de sequência a ser escrito                  | Inversão observável no broker. Consumidores ordenam por `walletVersion`, então a garantia é esta, não FIFO       | **P1** (teste do enunciado ausente) | Provar a sequência observável; avaliar "rodadas" por agregado e comparar o custo em requisições         | Em andamento                                                             |
| 7   | Métricas do worker                                               | Contadores só na memória do processo; impressos uma vez, no encerramento                                  | `src/worker.ts` escreve o snapshot só após `runWorker` retornar                         | Métricas de DLQ, retries e lag do outbox somem se o worker morrer; nada é visto em operação                      | **P1** (requisito §10 e §12)        | Endpoint interno de métricas, não publicado no host                                                     | Aberto                                                                   |
| 8   | Dockerfile                                                       | Imagem roda como `root`, sem `HEALTHCHECK`                                                                | Leitura do `Dockerfile`                                                                 | Superfície maior se a imagem for comprometida                                                                    | P2                                  | `USER bun`; verificar o build com a CA da sandbox                                                       | Aberto                                                                   |
| 9   | Documentação em português                                        | `README.md` em inglês; enunciado pede PT-BR como idioma principal                                         | Leitura                                                                                 | Avaliador lê em outra língua do que a exigida                                                                    | P2                                  | README em PT-BR, e `README.en.md` com o texto atual                                                     | Aberto                                                                   |
| 10  | Contrato OpenAPI                                                 | Inexistente antes; agora `docs/openapi.json`, com 10 operações                                            | `openapi-contract.test.ts`, `openapi-responses.test.ts`                                 | Divergência entre contrato e respostas. A verificação achou uma: `seq` é texto, não inteiro                      | P2                                  | Contrato escrito à mão, verificado contra as rotas e as respostas                                       | **Validado** (DOC-01 a DOC-04)                                           |
| 11  | Comparação com referências públicas                              | `docs/REFERENCE_REVIEW.md` não foi atualizado nesta rodada                                                | Não há acesso aos repositórios de referência nesta sessão (fora do escopo permitido)    | Comparação desatualizada                                                                                         | P2                                  | Atualizar numa sessão com acesso aos commits                                                            | **Fora do escopo desta rodada**                                          |
| 12  | Benchmarks 1/2/4 CPUs, soak de 15–30 min, backlog                | Relatórios anteriores em `docs/LOAD_TEST_RESULTS.md`                                                      | Não reexecutados nesta rodada                                                           | Números antigos sem reprodução nesta sessão                                                                      | P2                                  | Reexecutar em ambiente descartável                                                                      | **Fora do escopo desta rodada**                                          |
| 13  | Console de engenharia e laboratório de carga                     | Inexistentes                                                                                              | —                                                                                       | Escopo grande; ganho demonstrável só depois do backend estar fechado                                             | Opcional                            | Não construir nesta rodada; ver justificativa abaixo                                                    | **Fora do escopo desta rodada**                                          |
| 14  | Prometheus e Grafana                                             | Inexistentes                                                                                              | —                                                                                       | Sem coleta correta de workers (item 7), não há o que expor                                                       | Opcional                            | Depende do item 7; não justificado nesta rodada                                                         | **Fora do escopo desta rodada**                                          |
| 15  | Vitrine pública estática                                         | Gerador de uma página, a partir de arquivos do repositório; workflow do GitHub Pages                      | `static-showcase.test.ts`: 10 casos                                                     | Publicação sem verificação: a URL não existe até a configuração do repositório                                   | P2                                  | Publicar só depois da fonte "GitHub Actions" ser habilitada, e verificar a URL real antes de declará-la | **Validado** o build (SHW-01, SHW-02); **BLOCKED** a publicação (SHW-03) |

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

## Resultado desta rodada

Separado conforme o enunciado (§17). Cada item cita a linha da matriz ou o comando que o prova.

### Implementado e validado

- **Compose:** portas publicadas em `127.0.0.1`; no modo protegido, só a borda publica (INF-01 a INF-03).
- **Container:** API roda como `bun` (uid 1000) e tem healthcheck pelo runtime; a stack inteira subiu a partir da
  imagem verificada, com `docker compose ps` em `healthy` (INF-04, INF-05).
- **Modo protegido:** `bun run test:edge`, 12 de 12, contra a stack em execução (INF-06).
- **Autorização:** 28 casos adversariais; esquema `Bearer` case-insensitive (AUTH-06). Transação alheia por UUID
  mantém `403`, decisão registrada em ARCHITECTURE §12.
- **Mensageria:** sequência E1, E2, E3 da mesma wallet, com o estado do outbox e a ordem no SQS real (OUT-12).
  Garantia para consumidores documentada em ARCHITECTURE §8.
- **Observabilidade:** superfície interna do worker, com métricas enquanto roda (OBS-06).
- **Contrato:** OpenAPI com 10 operações, verificado contra as rotas e contra as respostas reais (DOC-01 a DOC-04).
- **Documentação:** README em português, `README.en.md`, guia do avaliador e glossário (PT-BR).
- **Demonstração:** `bun run demo:finance` passa as 5 seções, sem `.env`, contra a stack padrão (INF-07).
- **Vitrine:** `bun run site:build` gera a página a partir de dados do repositório; 10 casos de verificação (SHW-01, SHW-02).

### Implementado, com validação parcial

- **Build da imagem do repositório:** falha nesta sandbox, por `SELF_SIGNED_CERT_IN_CHAIN` no `bun install`.
  A imagem foi construída de uma cópia do Dockerfile que só acrescenta a CA da sandbox. O Dockerfile do repositório
  não foi construído diretamente.
- **`edge:check`:** usa `--build`, que a sandbox não executa. Foram executados `edge:up` equivalente (com a imagem
  verificada) e `test:edge`.
- **Publicação da vitrine:** não publicada. Ver abaixo.

### Preparado para deploy, não publicado

- **GitHub Pages:** `.github/workflows/pages.yml` faz o build e o deploy. Exige a fonte "GitHub Actions" em
  Settings > Pages do repositório. Até isso, nenhuma URL existe, e nenhuma é declarada (SHW-03, BLOCKED).

### Não implementado, com motivo

| Item                                                                  | Motivo                                                                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console de engenharia e laboratório de carga                          | Dependem de telemetria verdadeira em operação; a superfície do worker acabou de ser criada. Construí-los agora mostraria pouco.                      |
| Prometheus e Grafana                                                  | Sem coleta por instância validada em execução, um painel mostraria apenas snapshots.                                                                 |
| `fast-check`                                                          | A biblioteca não traria prova além dos testes existentes.                                                                                            |
| Reexecução dos benchmarks (1, 2 e 4 CPUs, soak de 15–30 min, backlog) | Não executada nesta rodada. O ambiente tem 4 vCPUs e Docker, então é a próxima etapa recomendada. Os números publicados são de execuções anteriores. |
| Atualização de `docs/REFERENCE_REVIEW.md`                             | Os repositórios de referência estão fora do escopo desta sessão, e não foram lidos.                                                                  |
| Revisão adversarial independente (etapa 10)                           | Não feita. Esta auditoria foi feita pelo próprio autor do código.                                                                                    |
| Alternativa de publicação por rodadas no outbox                       | Avaliada por contagem de requisições e não adotada. Ver a seção de mensageria.                                                                       |
| Troca de `403` por `404` na transação alheia                          | Depende de decisão do dono do contrato. A mudança está descrita em ARCHITECTURE §12.                                                                 |

### Commits desta rodada

Ver a lista completa na vitrine (`docs/site/`) e no histórico do branch. Em ordem:
`a86b5b2` (infra), `7c9b39a` (auth), `12bb1c4` (mensageria), `ebb3e84` (métricas do worker),
`a03d8de` (runtime não-root e healthchecks), `faf597c` (OpenAPI), `0bc7612` (documentação PT-BR),
`b5b1c6a` (vitrine), `bc8a5f9` (registro das suítes novas).

### Gate final

`bun run check:all`, sobre a árvore deste commit: 326 unitários, 4 de infraestrutura, 144 de integração,
23 de concorrência e 100 e2e, todos passando, contra PostgreSQL 17 e LocalStack 4.14 reais. A linha de base
antes de qualquer alteração era 288, 143, 22 e 66.
