# Baseline de carga local

> Versão principal em português. A cópia de referência em inglês é [LOAD_TEST_BASELINE.en.md](LOAD_TEST_BASELINE.en.md).
> Metodologia e critérios de cada passo estão em [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md), o relatório da medição
> feita na nuvem, gerado automaticamente. Esta página mede a mesma suíte em outra máquina, com 13 cenários.

## O que esta baseline é e o que não é

- **É** uma medição reproduzível: ambiente, método, limites e registros brutos ficam no repositório, e a tabela sai
  de um comando. Serve para comparar cenários (número de APIs, de CPUs e de workers) na mesma máquina.
- **Não é** uma meta de requisições por segundo. O enunciado não define meta de RPS e avalia a qualidade do
  experimento e a honestidade da análise (seção 14 de [CHALLENGE.md](CHALLENGE.md)).
- **Não é** uma comparação de melhoria. A máquina local e a da nuvem são diferentes, como mostra a tabela de ambiente.

## Ambiente

| Item        | Local (esta baseline)                            | Nuvem ([LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md)) |
| ----------- | ------------------------------------------------ | ---------------------------------------------------- |
| Processador | AMD Ryzen 7 7735HS, 8 núcleos e 16 threads (SMT) | Intel Xeon @ 2.10 GHz, 4 vCPUs                       |
| Memória     | 22 GiB                                           | 15.7 GiB                                             |
| Sistema     | Linux 7.2.6                                      | Linux 6.18.44                                        |
| Bun         | 1.4.4                                            | 1.4.4                                                |
| Docker      | 29.9.2                                           | não registrado no relatório                          |
| PostgreSQL  | 17 (`postgres:17-alpine`), configuração padrão   | 17, configuração padrão                              |
| LocalStack  | 4.14.0, SQS                                      | 4.14, SQS                                            |

Na máquina local, as CPUs `n` e `n+1` (com `n` par) são threads do mesmo núcleo. Por isso, uma stack de 2 CPUs
ocupa um núcleo inteiro, e uma de 1 CPU divide o núcleo com o gerador.

## Como reproduzir

```text
bun run infra:up
LOAD_CPUS=2 LOAD_API_PROCESSES=1 LOAD_WORKER_PROCESSES=2 \
  LOAD_RATES=10,25,50,75,100,125,150,200,300,400,500,600,800,1000,1200,1500 \
  LOAD_RESULTS_DIR=docs/load/local/apis1-workers2-cpus2 \
  LOAD_REPORT_PATH="$(mktemp)" \
  bun run test:load
bun run load:consolidate docs/load/local
```

- `LOAD_CPUS` é o número de CPUs da stack. `LOAD_API_PROCESSES` e `LOAD_WORKER_PROCESSES` trocam a topologia, e o
  padrão é o acordado (3 APIs e 2 workers).
- `LOAD_RATES` é a rampa. O padrão do harness para em 400 req/s, e isso não basta para 8 CPUs; por isso a matriz
  usou a lista acima.
- Sem `LOAD_RESULTS_DIR` e `LOAD_REPORT_PATH`, a execução grava em `docs/load/results/` e em
  `docs/LOAD_TEST_RESULTS.md`, que são os resultados da nuvem. Aponte os dois para outro lugar.
- O nome do cenário segue `apis<A>-workers<W>-cpus<N>`. Cada diretório em `docs/load/local/` tem um `cpus-<N>.json`,
  o registro bruto da execução.

## Resultados

Cada linha é uma execução, com a rampa inteira. Os cabeçalhos vêm do consolidador (`test/load/consolidate.ts`) e
estão em inglês de propósito, para continuar iguais ao relatório da nuvem.

| Scenario             | APIs | Workers | Stack CPUs | Agreed (req/s) | Per stack CPU (req/s) | CPU µs/req | Utilisation | API CPU % | Worker CPU % | PostgreSQL % | LocalStack % | Largest process RSS (MiB) | First failing (req/s) | Why it failed                                     |
| -------------------- | ---: | ------: | ---------: | -------------: | --------------------: | ---------: | ----------: | --------: | -----------: | -----------: | -----------: | ------------------------: | --------------------: | ------------------------------------------------- |
| apis1-workers2-cpus1 |    1 |       2 |          1 |            150 |                 150.0 |       4754 |         71% |        35 |            4 |           26 |            7 |                       287 |                   200 | p95 1887.8 ms (max 500); p99 1940.9 ms (max 1000) |
| apis1-workers2-cpus2 |    1 |       2 |          2 |            300 |                 150.0 |       5301 |         79% |        69 |            9 |           64 |           16 |                       325 |                   400 | p95 4437.0 ms (max 500); p99 4598.0 ms (max 1000) |
| apis1-workers2-cpus4 |    1 |       2 |          4 |            400 |                 100.0 |       5242 |         52% |        86 |           15 |           85 |           24 |                       288 |                   500 | p95 2448.5 ms (max 500); p99 2520.0 ms (max 1000) |
| apis1-workers2-cpus8 |    1 |       2 |          8 |            500 |                  62.5 |       4713 |         29% |        94 |           15 |          102 |           25 |                       312 |                   600 | p95 1965.3 ms (max 500); p99 1989.3 ms (max 1000) |
| apis2-workers2-cpus1 |    2 |       2 |          1 |            150 |                 150.0 |       5556 |         83% |        43 |            4 |           29 |            7 |                       257 |                   200 | p95 4789.1 ms (max 500); p99 4974.4 ms (max 1000) |
| apis2-workers2-cpus2 |    2 |       2 |          2 |            300 |                 150.0 |       6164 |         92% |        88 |            9 |           70 |           16 |                       291 |                   400 | p95 7419.4 ms (max 500); p99 7824.9 ms (max 1000) |
| apis2-workers2-cpus4 |    2 |       2 |          4 |            500 |                 125.0 |       6237 |         78% |       137 |           18 |          127 |           30 |                       273 |                   600 | p95 1365.9 ms (max 500); p99 1411.3 ms (max 1000) |
| apis2-workers2-cpus8 |    2 |       2 |          8 |            600 |                  75.0 |       5472 |         41% |       147 |           18 |          130 |           34 |                       267 |                   800 | p95 1326.2 ms (max 500); p99 1405.9 ms (max 1000) |
| apis3-workers1-cpus2 |    3 |       1 |          2 |            200 |                 100.0 |       6590 |         66% |        67 |            6 |           48 |           10 |                       223 |                   300 | p95 1083.5 ms (max 500); p99 1904.3 ms (max 1000) |
| apis3-workers2-cpus1 |    3 |       2 |          1 |            125 |                 125.0 |       6557 |         81% |        45 |            4 |           26 |            6 |                       176 |                   150 | p95 600.3 ms (max 500); p99 1348.7 ms (max 1000)  |
| apis3-workers2-cpus2 |    3 |       2 |          2 |            200 |                 100.0 |       6764 |         68% |        68 |            6 |           49 |           11 |                       260 |                   300 | p95 4415.7 ms (max 500); p99 4651.5 ms (max 1000) |
| apis3-workers2-cpus4 |    3 |       2 |          4 |            500 |                 125.0 |       6742 |         84% |       162 |           17 |          130 |           29 |                       264 |                   600 | p95 2488.8 ms (max 500); p99 2626.1 ms (max 1000) |
| apis3-workers2-cpus8 |    3 |       2 |          8 |            800 |                 100.0 |       6422 |         63% |       237 |           25 |          197 |           44 |                       276 |                  1000 | p95 8963.9 ms (max 500); p99 9299.4 ms (max 1000) |

Legenda:

- **Agreed:** a maior taxa do último passo que passou em todas as restrições de [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md),
  com passos de 20 s. A rampa para no primeiro passo que falha.
- **CPU µs/req:** CPU da stack acima do ocioso, dividido pelas requisições respondidas, no passo acordado.
- **Utilisation:** CPU líquida da stack dividida pelas CPUs dadas a ela.
- **API, Worker, PostgreSQL, LocalStack %:** CPU líquida de cada grupo no passo acordado. 100 é um núcleo inteiro.
  Com várias APIs, o valor é a soma dos processos.
- **Largest process RSS:** maior RSS de um processo entre todos os passos da execução, amostrado a cada 500 ms. É um
  piso do pico real.
- **First failing e Why it failed:** o primeiro passo que quebrou uma restrição, com o motivo.

### Correção, latência e concorrência no passo acordado

Mesmos cenários, no passo acordado de cada um. Os cabeçalhos seguem o consolidador, em inglês.

| Scenario             | Error rate (%) | Lost | 5xx | Violations | Duplicates | Incorrect answers | Concurrency conflicts (whole run) | Lock waiters mean / max | Outbox drain (s) | Events created | p50 (ms) | p95 (ms) | p99 (ms) | Generator lag p99 (ms) |
| -------------------- | -------------: | ---: | --: | ---------: | ---------: | ----------------: | --------------------------------: | ----------------------: | ---------------: | -------------: | -------: | -------: | -------: | ---------------------: |
| apis1-workers2-cpus1 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.1 / 1 |              0.0 |           4461 |      8.2 |     93.5 |    145.8 |                    1.1 |
| apis1-workers2-cpus2 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.5 / 4 |              0.0 |           8933 |     20.7 |    165.7 |    245.1 |                    1.2 |
| apis1-workers2-cpus4 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.2 / 3 |              0.0 |          12092 |      9.2 |     25.3 |     49.6 |                    1.3 |
| apis1-workers2-cpus8 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.3 / 5 |              0.0 |          14939 |      8.2 |     74.4 |    109.3 |                    1.1 |
| apis2-workers2-cpus1 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.3 / 4 |              0.0 |           4457 |     23.7 |    117.0 |    160.8 |                    1.1 |
| apis2-workers2-cpus2 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                5.1 / 11 |              0.2 |           8945 |     72.6 |    328.6 |    538.7 |                    1.6 |
| apis2-workers2-cpus4 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.5 / 7 |              0.0 |          15042 |     11.5 |     40.1 |     74.3 |                    1.1 |
| apis2-workers2-cpus8 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.3 / 6 |              0.0 |          18080 |      7.4 |     17.5 |     64.8 |                    1.3 |
| apis3-workers1-cpus2 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.3 / 7 |              0.0 |           6020 |      7.7 |    103.8 |    307.5 |                    1.5 |
| apis3-workers2-cpus1 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                1.8 / 12 |              0.0 |           3770 |     31.3 |    341.7 |    658.8 |                    1.2 |
| apis3-workers2-cpus2 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                0.7 / 14 |              0.0 |           5940 |      8.9 |    135.8 |    339.1 |                    1.8 |
| apis3-workers2-cpus4 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                6.7 / 22 |              0.0 |          14873 |     17.3 |    391.6 |    602.7 |                    1.1 |
| apis3-workers2-cpus8 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                6.0 / 22 |              0.0 |          23898 |     11.3 |    277.0 |    602.7 |                    1.4 |

Legenda desta tabela:

- **Error rate:** requisições perdidas ou com 5xx, sobre as enviadas, no passo acordado.
- **Violations e Duplicates:** violações de saldo e de ledger, e duplicatas por provedor e identificador externo ou por
  chave de idempotência, verificadas após o passo.
- **Incorrect answers:** respostas que o contrato não permite para a requisição que as recebeu.
- **Concurrency conflicts (whole run):** conflitos de versão do contador `concurrency_conflicts_total`, em toda a execução.
- **Lock waiters mean / max:** sessões do PostgreSQL aguardando um lock, amostradas a cada 200 ms no passo acordado.
- **Outbox drain (s):** tempo até o outbox drenar depois do passo. O limite é de 60 s.
- **p50, p95, p99 (ms):** latência das requisições respondidas, medida a partir do horário programado do envio.
- **Generator lag p99 (ms):** atraso do gerador em relação ao cronograma. Acima de 50 ms, o passo é reprovado.

## Leitura

- **Uma API sozinha chega perto de um núcleo inteiro.** Com 1 API e 8 CPUs, o processo de API usa 94% de um núcleo
  no passo acordado de 500 req/s, e a stack inteira usa só 29% das CPUs dadas. Entre 4 e 8 CPUs, o acordado sobe de 400 para
  500 req/s. Isso é compatível com o processo Node/Bun de thread única ser o limite.
- **Mais APIs ajudam quando há CPU sobrando, e atrapalham quando falta.** Com 4 CPUs, 2 ou 3 APIs chegam a 500
  req/s, contra 400 de 1 API. Com 1 e com 2 CPUs, 3 APIs ficam abaixo de 1 API (125 e 200, contra 150 e 300).
- **Com 3 APIs e 8 CPUs, a stack chega a 800 req/s**, com cada API perto de 79% de um núcleo (237% somados). É o
  maior acordado desta baseline. Com 2 APIs em 8 CPUs, cada API fica perto de 73%, e o acordado é 600.
- **Um worker ou dois não mudou o acordado com 2 CPUs e 3 APIs.** Os dois ficam em 200 req/s, e falham em 300. Esta
  leitura vem de uma execução por lado, e não diz nada sobre outras configurações.
- **A quebra é brusca.** No passo acordado, o p99 ficou entre 50 e 660 ms. No primeiro passo que falha, o p95 vai de
  600 ms a 9 s, e o p99 de 1.3 s a 9.3 s. Os motivos são registrados na última coluna.
- **Não linear no cenário de 3 APIs com 1 CPU.** O p99 foi de 851 ms a 100 req/s e de 659 ms a 125 req/s, e 75
  req/s deu 56 ms. Pode ser ruído ou contenção pela mesma CPU. Esta execução não separa as duas hipóteses.
- **CPU por requisição local está entre 4713 e 6764 µs.** Na nuvem, os mesmos cenários de 3 APIs ficam entre 6764 e
  8320 µs. A diferença é de máquina, e não há evidência de melhoria da aplicação. Veja a seção de comparação.
- **Correção no passo acordado.** Nas 13 execuções, o erro foi de 0.000%, sem perdas, sem 5xx, sem violações, sem
  duplicatas e sem respostas incorretas. O atraso do gerador ficou entre 1.1 e 1.8 ms (p99), então o gerador não
  limitou os passos acordados. Os passos foram aprovados nas restrições de latência: p95 até 500 ms e p99 até 1000 ms.
- **Concorrência: zero conflito de versão, com espera por lock.** O contador de conflitos ficou em zero nas 13
  execuções. Isso é o esperado pelo desenho: a leitura da carteira usa `PESSIMISTIC_WRITE`, e a checagem de versão
  só dispara se o lock falhar. A contenção aparece como espera por lock: em média até 6.7 sessões e no pico 22, nas
  execuções de 3 APIs com 4 e 8 CPUs. A espera não é separada por carteira, então não dá para atribuí-la ao hot wallet.
- **Drenagem do outbox.** Foi de 0.0 s em 12 execuções e de 0.2 s em uma (2 APIs, 2 CPUs), dentro do limite de 60 s.

## Limitações

- **Uma execução por cenário.** Não há intervalo de confiança. Um cenário pode mudar de lado de uma restrição em outra
  execução, e um passo de 20 s prova só os 20 s em que rodou.
- **CPU lógica não é núcleo.** Com 2, 4 e 8 CPUs, a stack ocupa núcleos inteiros. Com 1 CPU, o gerador pode rodar no
  thread irmão da stack, e isso pode pesar contra o resultado de 1 CPU.
- **O gerador é um processo só,** rodando nas CPUs que sobram. A restrição de lag do gerador (p99 de 50 ms) faz
  parte da aprovação de cada passo. Uma falha por lag aparece na coluna "Why it failed".
- **A memória é amostrada.** O pico a cada 500 ms pode perder um pico curto.
- **LocalStack não é SQS da AWS,** e o PostgreSQL roda com configuração padrão, sem réplica e sem ajuste.
- **Só o caminho HTTP.** O mix de carga passa pela API; o caminho pela fila de comandos é coberto pelos testes de
  concorrência, e não entra nesta medição.

## Mudanças no harness para esta medição

- `LOAD_API_PROCESSES` e `LOAD_WORKER_PROCESSES` trocam a topologia. O padrão continua 3 APIs e 2 workers.
- A afinidade registrada de cada processo passou a ser lida no fim da execução. Antes, era lida logo após o spawn dos
  workers, antes de o `taskset` executar, e registrava a afinidade do gerador (por exemplo `1-15`). A correção não
  altera a medição, só o registro. Não verifiquei se o registro da nuvem para `worker-1` com 1 CPU (`1-3`) tem a mesma
  causa.
- A frase de limites do relatório deixou de citar 3 APIs e 2 workers fixos.
- O consolidador `bun run load:consolidate` gera a tabela desta página. Validado contra os registros publicados da
  nuvem: reproduz 100, 200 e 400 req/s, 8320, 7234 e 6764 µs por requisição, as mesmas primeiras falhas e os mesmos
  motivos.
- A coluna de maior RSS foi incluída no consolidado.

## Comparação com a nuvem, lado a lado

Mesma topologia (3 APIs, 2 workers), máquinas diferentes. Não é uma medida de melhoria.

| CPUs da stack |                    Nuvem: acordado (req/s) | Local: acordado (req/s) | Nuvem: CPU µs/req | Local: CPU µs/req |
| ------------: | -----------------------------------------: | ----------------------: | ----------------: | ----------------: |
|             1 |                                        100 |                     125 |              8320 |              6557 |
|             2 |                                        200 |                     200 |              7234 |              6764 |
|             4 | 400 (topo da rampa, sem limite encontrado) |                     500 |              6764 |              6742 |

Na nuvem, 4 CPUs chegou ao topo da rampa padrão (400 req/s) sem falhar, então o acordado de 400 é um piso, e não o
limite. Aqui, o limite de 4 CPUs ficou em 500 com falha em 600.

## Arquivos

- `docs/load/local/<cenário>/cpus-<N>.json`: os 13 registros brutos desta baseline.
- `test/load/consolidate.ts` e o script `load:consolidate` no `package.json`: geram a tabela.
- `docs/LOAD_TEST_RESULTS.md` e `docs/load/results/`: resultados da nuvem, sem alteração nesta rodada.
