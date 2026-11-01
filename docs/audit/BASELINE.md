# Baseline da rodada de auditoria

Estado do repositório antes de qualquer alteração desta rodada, e os resultados das verificações nesse estado.
Todos os números abaixo vêm de execuções registradas nesta sessão; os logs estão em
`scratchpad/baseline/` da sessão e os comandos estão listados para reprodução.

## 1. Origem e árvore

| Item                                      | Valor                                                                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit inicial                            | `d65a1e7` (`origin/main` e a branch de trabalho `ccr-db6e8d7e-jagf0w` apontavam para ele)                                                           |
| Branch de trabalho                        | `ccr-db6e8d7e-jagf0w`: é a branch designada pelo ambiente. Estava igual à `main` no início, e por isso a rodada começa dela, sem criar outra branch |
| Árvore                                    | limpa (`git status --short` vazio)                                                                                                                  |
| Commits da `main` desde a rodada anterior | `7f20722` e `430f3a3` (README, de outro autor), integrados por merge em `1d7bad9` e `18f7509`, e `d65a1e7` (formatação da tabela de desempenho)     |
| CI de `d65a1e7`                           | `Bun checks` concluído com sucesso (run 41254321360); `Static showcase` concluído com sucesso (run 41254321340)                                     |
| CI de `18f7509` (intermediário)           | `Bun checks` falhou na verificação de formato do README (run 41254303933). Corrigido por `d65a1e7`                                                  |

## 2. Ambiente

| Item                                   | Valor                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Host                                   | Linux 6.18.44 (sandbox), 4 vCPU Intel Xeon 2,10 GHz, 16 GiB de RAM                                        |
| Bun                                    | 1.4.4 (fixado no `Dockerfile` e no CI)                                                                    |
| Node                                   | v22.23.4 (disponível; o projeto usa Bun)                                                                  |
| Docker                                 | 29.9.2                                                                                                    |
| PostgreSQL                             | `postgres:17-alpine` (compose)                                                                            |
| LocalStack                             | `localstack/localstack:4.14.0` (compose)                                                                  |
| Migrations no banco de desenvolvimento | 9 aplicadas (`Migration20260731000000` a `Migration20260731000008`), confirmado em `mikro_orm_migrations` |

**Limitação do ambiente.** `docker compose up --build` não constrói a imagem neste sandbox: `bun install`
falha com `SELF_SIGNED_CERT_IN_CHAIN`, porque o proxy TLS da sandbox não é confiável dentro do build
(ARCHITECTURE §14, já documentado). Para executar a pilha, foi gerada uma imagem de teste **fora do
repositório** (`wgr-scratch:latest`), a partir de uma cópia do `Dockerfile` que confia no CA da sandbox,
com um `docker-compose` override que aponta `migrate`, `api` e `worker` para ela. O repositório não foi
alterado para isso.

## 3. Verificações no estado inicial

| Comando                                                      | Resultado                                                                                                                 | Observação                                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check:fast`                                         | rc 0. Typecheck, lint, formato e 384 testes unitários em 36 arquivos, todos passando                                      | —                                                                                                                                                                                        |
| `bun run check:all` (primeira tentativa)                     | rc 1                                                                                                                      | Falha **de ambiente**: o daemon Docker tinha parado, o PostgreSQL não respondia, e 29 testes de integração falharam em `beforeAll` (`database.drop` indefinido). Não é defeito do código |
| `bun run check:all` (após reiniciar o daemon e o `infra:up`) | rc 0: unit 384, infra 4, integração 151 (15 arquivos), concorrência 23 (5 arquivos), e2e 100 (9 arquivos), todos passando | Este é o baseline válido                                                                                                                                                                 |
| `bun run db:migrate`                                         | rc 1 na primeira tentativa, porque o comando exige `DATABASE_URL` no ambiente                                             | Não é defeito. Com a variável definida, 9 migrations estão aplicadas                                                                                                                     |
| `bun run demo:finance`                                       | rc 1: `ECONNREFUSED localhost:3000`                                                                                       | Precisa da pilha em execução (API na porta 3000). Não executado no baseline; ver §5                                                                                                      |
| `bun run site:build`                                         | rc 0: 7 arquivos para o commit `d65a1e7`, 247 links do repositório verificados                                            | —                                                                                                                                                                                        |

Os testes de integração, concorrência e e2e usam PostgreSQL e LocalStack reais. Cada arquivo de teste
cria o próprio banco migrado e o descarta ao final, de modo que nenhum dado de desenvolvimento é tocado.

## 4. Estado do esquema no banco (catálogo)

Lido do PostgreSQL de desenvolvimento, no estado inicial:

- 50 constraints em `pg_constraint` (incluindo as chaves primárias e a de `mikro_orm_migrations`).
- 22 índices, incluindo os parciais `wager_one_processed_reversal_per_reference`,
  `wager_one_processed_settlement_per_reference`, `wager_pending_reference_due_idx` e
  `outbox_due_unpublished_idx`.
- 2 triggers de usuário: `wallet_ledger_entries_no_update_or_delete` e `wallet_ledger_entries_no_truncate`
  (imutabilidade do ledger).
- Não há trigger, nem constraint, que garanta que o saldo de uma wallet é igual ao último lançamento do
  ledger, ou que a cadeia de lançamentos é contínua. Esses dois pontos são tratados na auditoria
  (`FINDINGS.md`, F-06).

## 5. Pendências de ambiente registradas no baseline

- `demo:finance` e os testes de carga dependem da pilha Compose em execução. A imagem do repositório não
  constrói no sandbox (§2). A execução com a imagem de teste está descrita em `FINDINGS.md`, seção
  "Execução do demo".
- A URL pública do GitHub Pages (`https://dedeusgui.github.io/backend-challenge/`) não é alcançável a
  partir do sandbox. Não foi verificada nesta rodada.

## 6. Inventário das medições já versionadas

| Conjunto                                                        | Arquivos                                    | Papel                                |
| --------------------------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| `docs/load/results/`                                            | `cpus-1.json`, `cpus-2.json`, `cpus-4.json` | Relatório pinado por número de CPUs  |
| `docs/load/paired/baseline-a10fd11/`                            | `cpus-1.json`, `cpus-2.json`, `cpus-4.json` | Baseline pareado do commit `a10fd11` |
| `docs/load/paired/A1`, `A2`, `B1`, `B2`, `C1`, `C2`, `E1`, `E2` | `cpus-2.json` cada                          | Pares antes/depois de cada alteração |
| `docs/load/smoke/5cf454c/`                                      | `cpus-1.json`                               | Smoke de uma CPU                     |

Total: 15 arquivos. Nenhum deles foi regenerado nesta rodada.

## 7. Diagramas e Pages

- Os três SVG referenciados pelo README (`docs/diagrams/bet-over-http.svg`,
  `docs/diagrams/queued-command.svg`, `docs/diagrams/outcome-entities.svg`) existem na árvore e são
  idênticos (`cmp`) às cópias que o build da vitrine publica em `site/diagrams/`.
- O workflow de Pages da `main` concluiu com sucesso no commit `d65a1e7`.
