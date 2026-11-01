# Histórico de testes de carga

> **Leia isto primeiro: as execuções de 0 a 6 foram substituídas.** Elas foram feitas com um driver que iniciava `ps` e
> `docker stats` de dentro do próprio loop do gerador de carga, a cada 500 ms e a cada leitura. Essas
> inicializações de processos atrasavam o gerador, e o atraso entrava na latência. Na mesma stack a
> 50 req/s, o primeiro driver mediu um p99 de 478 ms e o que não inicia processos durante uma etapa
> mediu 48 ms, com o p99 do lag do gerador caindo de 44 ms para 1.9 ms (`DECISIONS.md`, N-16). Portanto, as
> latências abaixo são pessimistas, assim como o valor acordado de 150 req/s derivado delas. As
> execuções fixadas em `LOAD_TEST_RESULTS.md` as substituem. As execuções permanecem aqui como registro do que foi
> medido e do motivo da mudança do driver.

As execuções fixadas que substituem estas estão em `docs/LOAD_TEST_RESULTS.md`, com um registro por contagem de CPUs em
`docs/load/results/`. O primeiro registro de 4 CPUs foi substituído por sua reexecução, pois o primeiro driver não
elevou o limite in-flight do gerador quando o gerador não possuía CPUs próprias.

`docs/LOAD_TEST_RESULTS.md` é regravado a cada execução, portanto mantém apenas a última. Este
arquivo guarda as demais. Os números foram copiados dos logs de execução. Cada execução é na mesma máquina,
uma VM de nuvem de 4 vCPUs com 15.7 GiB de memória, com todos os componentes nela: três processos de API, dois
workers, PostgreSQL 17, LocalStack 4.14 e o driver de carga.

## Valor acordado

**150 requisições por segundo sustentadas.** Cada execução que atingiu 150 passou sem perdas e sem erros.
200 é o teto observado: passou em quatro das seis execuções, e seu p99 variou de 156 ms a 555 ms.
A execução 5 perdeu uma requisição a 200. A execução 3 parou em 100, devido à antiga restrição de lag. 300 falhou em cada execução
que a alcançou, no p95 e p99 entre 3 e 5 segundos.

Concordamos em 150 porque se sustentou em todas as execuções, com margem. Um valor proveniente de uma única execução não sobreviveria
a uma segunda.

## Execuções

| Execução | Versão do driver                                            | Taxa acordada       | p99 a 200 req/s | 300 req/s                              | Perdidas (todas as etapas)         | Nota                                                                                           |
| -------- | ----------------------------------------------------------- | ------------------- | --------------- | -------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 0        | closed loop: 64 lanes, cada uma aguarda sua resposta        | não é modelo aberto | não medido      | não medido                             | 0 de 4000                          | A primeira versão. Oculta a fila, portanto não é comparada com o restante (N-01).              |
| 1        | modelo aberto, restrição no lag máximo do gerador           | 200                 | 235 ms          | falha: p95 5.2 s, lag do gerador 60 ms | 0                                  | Primeira rampa de modelo aberto.                                                               |
| 2        | modelo aberto, mesmas restrições                            | 200                 | 156 ms          | falha: p95 3.1 s                       | 0                                  | Repetição da execução 1.                                                                       |
| 3        | modelo aberto, mesmas restrições                            | 50                  | 56 ms (a 100)   | não alcançado                          | 0                                  | 100 req/s falhou em uma amostra de lag de 53 ms. Isso tornou a restrição de lag um p99 (N-02). |
| 4        | modelo aberto, restrição no p99 do lag                      | 200                 | 232 ms          | falha: p95 3.7 s                       | 0                                  | Primeira execução com a restrição final de lag.                                                |
| 5        | como na 4, mais CPU por componente e CPU do contêiner       | 150                 | 157 ms          | não alcançado                          | 1 a 200 req/s, erro não registrado | A perda foi classificada na execução 6, mas não nesta.                                         |
| 6        | como na 5, mais o nome do erro para cada requisição perdida | 200                 | 555 ms          | falha: p95 5.2 s, p99 5.3 s            | 0                                  | O relatório mais recente, em `LOAD_TEST_RESULTS.md`.                                           |

## O que as execuções mostram

- **O joelho está entre 200 e 300 requisições por segundo nesta máquina.** A falha a 300 é de
  latência, não de erros: nenhuma execução a 300 perdeu requisições.
- **A 300 req/s, a latência sobe para todas as carteiras, não apenas para a hot wallet.** Na execução 6, o p99
  de carteiras distintas foi de 3,953 ms e o p99 da hot wallet foi de 4,782 ms.
- **A CPU não explica os 300.** Na execução 6, cada processo de API utilizou 43% de uma CPU, o PostgreSQL usou
  101% (um núcleo), o LocalStack 43%, e a máquina como um todo cerca de 77%. O limite provável é o PostgreSQL,
  sob o lock de linha concorrida e o pool padrão de 10 conexões por processo. Trata-se de uma inferência. A
  execução não mediu esperas de lock nem esperas de pool, portanto não está comprovado.
- **A perda a 200 req/s na execução 5 foi uma única requisição.** Seu erro não foi registrado. Na execução 6, a
  mesma etapa não perdeu nada. Uma requisição perdida é uma violação de restrição (N-04), e é também sinal de
  problema no cliente ou no socket, não necessariamente do sistema. Registrar o erro é a forma de diferenciá-los.
- **A variância entre execuções é grande no topo da faixa.** O p99 a 200 req/s variou de 156 a
  555 ms. Uma execução não decide nada isoladamente. É por isso que o valor acordado é a taxa que se sustentou em todas as execuções.

## Para a máquina de entrevista

Execute `bun run test:load` nessa máquina e mantenha o seu `LOAD_TEST_RESULTS.md` com a tabela de ambiente
correspondente. A mesma rampa, as mesmas restrições e o mesmo método fornecem então um número que é comparável
com este. Os números desta máquina em nuvem não devem ser citados para outra máquina.

## Execuções da revisão de finalização, no host de sandbox

Estas execuções foram feitas em um host diferente da VM de nuvem acima: uma VM Firecracker de quatro vCPUs com 16 GiB de memória,
Docker, PostgreSQL 17, LocalStack 4.14 e Bun 1.4.4, com o mesmo harness. Os números não são comparáveis com
as execuções em nuvem. São comparáveis entre si.

**Antes e depois, no mesmo host, duas CPUs, as mesmas taxas (50, 100, 150, 200 req/s).** Cada rótulo é um
registro em `docs/load/paired/<label>/cpus-2.json`.

| Rótulo | Commit medido                                         | Acordado | p99 a 100 req/s | p99 a 150 req/s | CPU por requisição a 100 req/s |
| ------ | ----------------------------------------------------- | -------: | --------------: | --------------: | -----------------------------: |
| A1, A2 | `a10fd11`, antes do trabalho de desempenho da revisão | 100, 100 |     120, 134 ms |      2.5, 2.6 s |                  16.1, 15.8 ms |
| B1, B2 | `e6b0380`, com a instrumentação de fases              | 100, 100 |     463, 189 ms |      2.0, 2.6 s |                  17.0, 15.7 ms |
| C1, C2 | `89b7bc1`, lotes do outbox na ordem devida            | 150, 200 |       70, 60 ms |     233, 157 ms |                  12.9, 11.8 ms |
| E1, E2 | `9e8dabe`, caminho de lock com consulta indexada      | 200, 200 |       31, 32 ms |      75, 116 ms |                   9.7, 10.0 ms |

A instrumentação (B) não tem custo mensurável: sua CPU por requisição fica dentro da dispersão da linha de base. O
loteamento (C) e o caminho de lock (E) se reproduziram em ambas as execuções. Uma terceira configuração, o caminho de lock com
consulta única de resultado `kind IN (...)`, foi executada duas vezes e depois descartada. O `EXPLAIN` em 20,000 linhas mostrou que
a consulta fazia varredura na tabela, e suas execuções tiveram caudas piores a 150 req/s (`DECISIONS.md`, P-07).

**Rampa completa, a linha de base, `a10fd11`** (`docs/load/paired/baseline-a10fd11/`): 1 CPU acordou 25 req/s e falhou a
50; 2 CPUs acordaram 150 e falharam a 200; 4 CPUs foi inválido, porque o gerador compartilhou todas as quatro CPUs com a
stack e violou a restrição de lag do gerador a 50 req/s.

**O relatório fixado, `HEAD` desta revisão** (`docs/LOAD_TEST_RESULTS.md`, `docs/load/results/`): 1 CPU acordou 100
e falhou a 125; 2 CPUs acordaram 200 e falharam a 300; 4 CPUs passaram em todas as etapas até 400, o topo da
rampa configurada. O teto de 4 CPUs fica acima de 400 nesta medição, e não foi encontrado. O gerador compartilhou
as quatro CPUs com a stack nessa execução, portanto o valor é um limite inferior para a stack isolada.

Os registros da VM de nuvem eram o relatório fixado antes desta revisão. Estão no histórico do git, em `docs/load/results/`
no commit `596e9fc`.

## Execução de fumaça do driver atual (5cf454c)

Um registro, `docs/load/smoke/5cf454c/cpus-1.json`, medido com `LOAD_CPUS=1 LOAD_RATES=10,25 LOAD_STEP_SECONDS=5 LOAD_WARMUP_SECONDS=3 LOAD_IDLE_SECONDS=3`.
Não é uma campanha: duas taxas, cinco segundos cada, em uma CPU. Verifica se o driver roda de ponta a ponta com
o julgamento de respostas, a auditoria delimitada de duplicatas e as unidades dos resumos. Ambas as etapas passaram. 175
requisições foram enviadas, nenhuma foi perdida, nenhuma teve resposta incorreta, e nenhuma transação ou saldo foi duplicado ou
ficou incorreto. O esgotamento do outbox após cada etapa foi de 0.6 ms e 0.8 ms. Ao longo da execução, 493 eventos publicados tiveram
um lag de outbox com média de 0.192 s e máximo de 0.682 s.

Para renderizar este registro como relatório, sem medir: `LOAD_RESULTS_DIR=docs/load/smoke/5cf454c LOAD_REPORT_PATH=<file> LOAD_REPORT_ONLY=1 bun run test:load`.
