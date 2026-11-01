# Comparação de desempenho e de alternativas

Este documento registra os experimentos desta rodada de auditoria. Cada experimento tem hipótese, método,
resultado e decisão. Quando um experimento não mostrou benefício, a alteração foi descartada, e isso está
escrito aqui.

Ambiente comum: Linux, 4 vCPU Intel Xeon 2,10 GHz, Bun 1.4.4, PostgreSQL 17 (`postgres:17-alpine`), um processo
sem HTTP e sem SQS, para isolar o caminho financeiro (`ProcessWagerTransaction` com repositórios reais).
Os números valem para esta máquina e para esta execução. Não são estimativas de capacidade.

---

## Experimento 1 — triggers de concordância entre saldo e ledger

**Hipótese.** Dois triggers de restrição, adiados até o `COMMIT`, impedem que o saldo de uma wallet divirja do
último lançamento do ledger, e que um lançamento deixe de continuar a cadeia da sua wallet. Essa garantia está
descrita na invariante 6.2 do desafio, e hoje só é verificada pela aplicação e pelos testes. O custo esperado é
uma consulta indexada por transação, feita enquanto o lock da wallet ainda está ativo.

**Candidato.** `docs/audit/experiments/ledger-agreement-triggers.sql`. Não está nas migrations.

**Prova de correção.** `bun test test/experiments` (4 casos, incluindo um positivo). Sem o candidato, três das
quatro escritas diretas são aceitas pelo esquema atual. Com o candidato, as três são recusadas no `COMMIT`, e a
escrita coerente (saldo e lançamento juntos) é aceita. O resultado sem o candidato foi medido antes do
candidato existir: as três recusas falharam, e o caso positivo passou.

**Método de custo.** `test/perf/ledger-trigger-cost.ts`, com seis rodadas que alternam a ordem (com e sem
triggers), em bancos novos. Cada rodada tem três cargas: uma wallet em sequência (600 apostas), 120 wallets em
sequência (3 apostas cada, 360 no total) e uma wallet com 8 workers concorrentes (600 apostas). Os valores são
medianas das seis rodadas.

| Carga                   | Quantil | Sem triggers (mediana de 6) | Com triggers (mediana de 6) |        Diferença |
| ----------------------- | ------- | --------------------------: | --------------------------: | ---------------: |
| uma wallet, sequencial  | p50     |                     6,11 ms |                     6,21 ms | +0,10 ms (+1,6%) |
| uma wallet, sequencial  | p95     |                     8,09 ms |                     8,52 ms | +0,43 ms (+5,3%) |
| uma wallet, sequencial  | p99     |                     9,62 ms |                    10,52 ms | +0,90 ms (+9,4%) |
| 120 wallets, sequencial | p50     |                     6,12 ms |                     6,18 ms | +0,06 ms (+1,1%) |
| 120 wallets, sequencial | p95     |                     8,04 ms |                     8,21 ms | +0,17 ms (+2,1%) |
| 120 wallets, sequencial | p99     |                     9,25 ms |                     9,91 ms | +0,66 ms (+7,1%) |
| uma wallet, 8 workers   | p50     |                    39,36 ms |                    41,20 ms | +1,84 ms (+4,7%) |
| uma wallet, 8 workers   | p95     |                    50,01 ms |                    53,75 ms | +3,74 ms (+7,5%) |
| uma wallet, 8 workers   | p99     |                    65,34 ms |                    65,83 ms | +0,48 ms (+0,7%) |

**Variabilidade entre execuções.** Uma primeira execução de seis rodadas, com a mesma carga, deu o p99 do cenário
concorrente em +8,5 ms (+14,7%), e o p50 em +1,6 ms. A segunda execução deu +0,5 ms no p99 e +1,8 ms no p50.
Os valores estão em `docs/audit/perf/ledger-agreement-triggers.json`, com a execução mais recente. Ou seja: o
ruído de cauda desta máquina é da mesma ordem dos efeitos medidos. Seis rodadas não delimitam o p99.

**Crescimento com o ledger.** Cada verificação faz uma leitura de um lançamento pelo índice `(wallet_id, seq)`.
Medido com um ledger de 1 mil, 100 mil e 1 milhão de lançamentos, espalhados em wallets de 100 lançamentos cada:

| Lançamentos no ledger | Wallets | Tempo por leitura | Plano                                                      |
| --------------------: | ------: | ----------------: | ---------------------------------------------------------- |
|                 1 000 |      10 |           0,68 ms | varredura regressiva por `ledger_seq_key` (tabela pequena) |
|               100 000 |   1 000 |           0,44 ms | `ledger_wallet_seq_idx`                                    |
|             1 000 000 |  10 000 |           0,50 ms | `ledger_wallet_seq_idx`                                    |

Com o tamanho que cresce, o custo da leitura não cresce. O risco é o planejador: com estatísticas diferentes,
ele pode escolher a varredura regressiva por `ledger_seq_key` para uma wallet pequena num ledger grande, o que
seria O(n). Em produção, isso se verifica com `EXPLAIN` sobre o padrão da consulta.

**Locks.** Os dois triggers leem linhas (`wallets` e o índice do ledger). Não tomam lock de linha novo. Mas são
executados no `COMMIT`, quando o lock `FOR UPDATE` da wallet ainda está ativo. Cada transação paga, portanto, duas
leituras indexadas dentro da seção crítica da wallet. É esse o custo que aparece no cenário de contenção.

**Deadlocks e consultas repetidas.** Nenhum deadlock novo: os triggers não tomam locks que a aplicação não tome.
Cada transação financeira dispara uma verificação por linha alterada, duas no total.

**Decisão: não adotar.** Os argumentos:

1. A especificação exige que unicidade, imutabilidade e não-negatividade sejam garantidas no esquema (§5.9). A
   concordância entre saldo e ledger aparece como invariante (§6.2), mas não está entre as três exigências de
   esquema.
2. A detecção já existe: reconciliação sob demanda, com divergência reportada, contada e não corrigida em
   silêncio, e a verificação global ao final de cada suíte de integração.
3. O custo cai exatamente no caminho mais disputado do desafio (uma wallet quente). A mediana sobe 1,8 ms sob 8
   workers, e a cauda não pôde ser delimitada com seis rodadas.

**O que mudaria a decisão.** Um requisito explícito de proteção contra escrita fora da aplicação (por exemplo, um
operador com acesso direto ao banco). Nesse caso, o custo medido é aceitável, e o candidato está pronto para
virar migration. A decisão é do dono do desafio.

---

## Experimento 1b — guardas de linha (migration 10)

**Hipótese.** As guardas que leem apenas a linha alterada (imutabilidade de identidade e payload, transições de
status copiadas da tabela de domínio, linha terminal congelada, contador de tentativas monotônico, e a regra
de versão da wallet) não fazem nenhuma consulta. Devem custar praticamente nada no caminho crítico, diferente
dos triggers do experimento 1, que consultam o ledger.

**Método.** `bun run test/perf/ledger-trigger-cost.ts 6 --guards`. A variante é o esquema atual. A linha de base é o
mesmo esquema sem a migration 10 (`migrator.down()`). A carga é a mesma do experimento 1, com seis rodadas que
alternam a ordem. Os dados brutos estão em `docs/audit/perf/row-guards.json`.

| Carga                   | Quantil | Sem guardas (mediana de 6) | Com guardas (mediana de 6) |        Diferença |
| ----------------------- | ------- | -------------------------: | -------------------------: | ---------------: |
| uma wallet, sequencial  | p50     |                    6,05 ms |                    6,14 ms | +0,09 ms (+1,6%) |
| uma wallet, sequencial  | p95     |                    8,20 ms |                    8,51 ms | +0,31 ms (+3,8%) |
| uma wallet, sequencial  | p99     |                   10,02 ms |                    9,83 ms | −0,19 ms (−1,8%) |
| 120 wallets, sequencial | p50     |                    6,18 ms |                    6,17 ms | −0,01 ms (−0,2%) |
| 120 wallets, sequencial | p95     |                    8,29 ms |                    8,37 ms | +0,08 ms (+0,9%) |
| 120 wallets, sequencial | p99     |                    9,59 ms |                   10,12 ms | +0,54 ms (+5,6%) |
| uma wallet, 8 workers   | p50     |                   40,39 ms |                   40,14 ms | −0,25 ms (−0,6%) |
| uma wallet, 8 workers   | p95     |                   53,70 ms |                   54,86 ms | +1,16 ms (+2,2%) |
| uma wallet, 8 workers   | p99     |                   68,48 ms |                   72,34 ms | +3,85 ms (+5,6%) |

**Resultado.** Nas medianas, a diferença fica entre −0,6% e +1,6%. Nas caudas, as diferenças (até +5,6%) estão
dentro da variação entre execuções medida no experimento 1, de até 8 ms no p99 do cenário concorrente. Em seis
rodadas, nenhuma escrita da aplicação foi recusada, o que também é uma prova de que as guardas aceitam o que o
sistema escreve.

**Decisão: adotar.** O custo não é mensurável no mediano, a regra é local e não exige lock extra, e cada guarda
corresponde a uma exigência do desafio (identidade e payload, ciclo de vida das transições, versão da wallet).

**Limite.** Guardas de linha não verificam a concordância entre o saldo e o ledger, porque isso exige ler outras
linhas. Essa parte continua na reconciliação, e a suíte mostra que uma divergência com versão consistente
passa pela guarda e é reportada pela reconciliação.

---

## Experimento 2 — custo da extensão de visibilidade por mensagem

**Hipótese.** Renovar a visibilidade das mensagens que ainda esperam sua vez custa uma chamada
`ChangeMessageVisibilityBatch` por mensagem após a primeira. O custo esperado é o de uma requisição SQS extra
por mensagem, que se soma à recepção, ao processamento e à remoção.

**Estado.** Não medido nesta rodada. A correção (commit `b398e22`) foi validada pelo teste de concorrência
com LocalStack, mas o custo em throughput não foi medido. Entra como `OPTIMIZATION_CANDIDATE` em
`FINDINGS.md`, com a medição necessária descrita: rodar `test:load` pareado com e sem a renovação, com a pilha
em execução. Sem essa medição, o custo não é afirmado.

---

## Experimento 3 — teste de carga pareado

**Estado.** Não executado nesta rodada. A pilha Compose do repositório não constrói no sandbox (ver
`BASELINE.md` §2), e a execução com a imagem de teste exige tempo que não cabe nesta rodada. Os pares de
medição já versionados em `docs/load/` continuam sendo a referência. Nenhum número de carga novo é afirmado.

---

## Alterações descartadas

| Alteração                                                   | Motivo do descarte                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Triggers de concordância saldo/ledger no caminho de escrita | Experimento 1: custo mediano de até 1,8 ms sob contenção, com cauda não delimitada, e a especificação não exige o esquema para essa invariante |
