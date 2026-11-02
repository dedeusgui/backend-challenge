# Estratégia de testes

Cada garantia na [matriz de requisitos](REQUIREMENTS_MATRIX.md) indica a suíte que a
comprova. Uma linha só é `PASSING` após sua suíte ter sido executada e aprovada. Este documento descreve como
as suítes estão organizadas, o que cada uma pode ou não substituir, quais falhas elas injetam e
o que as evidências de mutação dizem sobre se elas podem falhar.

## Suítes e comandos

| Comando                    | O que executa                                                                                                                                                                                                               | Infraestrutura real             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `bun run typecheck`        | `tsc --noEmit` sobre `src` e `test`                                                                                                                                                                                         | nenhuma                         |
| `bun run lint`             | oxlint em `src` e `test`                                                                                                                                                                                                    | nenhuma                         |
| `bun run format:check`     | Prettier                                                                                                                                                                                                                    | nenhuma                         |
| `bun run test:unit`        | `test/unit`: regras de domínio, lógica pura, formatos de log e métrica, as regras de autenticação, os loops dos workers                                                                                                     | nenhuma                         |
| `bun run test:integration` | `test/integration`: esquema e migrações, persistência, casos de uso, mensageria, falhas, a tabela de autenticação                                                                                                           | PostgreSQL e LocalStack         |
| `bun run test:containers`  | piloto opcional: inicia PostgreSQL e LocalStack em containers efêmeros e roda seis arquivos representativos; aceita arquivos específicos após `--`                                                                          | Testcontainers e Docker         |
| `bun run test:concurrency` | `test/concurrency`: conexões paralelas, três processos de API e dois workers, crashes, encerramento                                                                                                                         | PostgreSQL e LocalStack         |
| `bun run test:e2e`         | `test/e2e`: a aplicação Nest via HTTP, com chaves de API e o contrato de entrada (entrada malformada é 400)                                                                                                                 | PostgreSQL e LocalStack         |
| `bun run test:load`        | `test/load`: execução opcional de carga por contagem de CPUs; grava em `docs/load/results` e `docs/LOAD_TEST_RESULTS.md`, ou em `LOAD_RESULTS_DIR` e `LOAD_REPORT_PATH` quando definidos                                    | PostgreSQL e LocalStack         |
| `bun run load:consolidate` | `test/load/consolidate.ts`: tabela consolidada dos cenários locais em `docs/load/local`, com capacidade e correção no passo acordado                                                                                        | nenhuma                         |
| `bun run check:fast`       | typecheck, lint, format, unit                                                                                                                                                                                               | nenhuma                         |
| `bun run test:edge`        | `test/edge`: modo protegido. A API não possui porta, limites por endereço, 429 como JSON, cabeçalhos forjados, isolamento, flood de conexões, o resultado financeiro através da borda. Requer a stack protegida (`edge:up`) | a stack protegida               |
| `bun run edge:check`       | inicia a stack protegida, executa `test:edge`, depois para a stack e relata seu código de saída                                                                                                                             | Docker                          |
| `bun run bench:edge`       | `test/edge/overhead.ts`: as mesmas leituras através da borda e diretamente, e a proporção de recusas nos limites padrão                                                                                                     | uma stack em execução           |
| `bun run demo:finance`     | `test/demo/finance.ts`: o fluxo financeiro da demonstração 1, contra a API em execução, verificando cada saldo                                                                                                              | a stack padrão                  |
| `bun run test:infra`       | `test/infra`: a configuração mesclada do Compose, lida por `docker compose config`. Nenhuma porta publicada vincula todas as interfaces; o modo protegido publica apenas a borda                                            | a CLI do Compose, sem contêiner |
| `bun run site:build`       | `scripts/build-site.ts`: a vitrine estática em `site/`, a partir dos dados do repositório. Seu teste compila em um diretório temporário                                                                                     | nenhuma                         |
| `bun run check:all`        | `check:fast`, depois integração, concorrência e e2e. Esta é a barreira de verificação, e o CI a executa                                                                                                                     | todas as anteriores             |

`test:load` não faz parte de `check:all`. Ele leva minutos, e seus números descrevem a máquina
onde é executado.

Inicie a infraestrutura com `bun run infra:up`. As suítes leem `DATABASE_URL` (padrão
`postgresql://wagering:wagering@localhost:5432/wagering`) e `SQS_ENDPOINT` (padrão
`http://localhost:4566`).

### Piloto opcional com Testcontainers

Compose permanece como caminho principal para desenvolvimento e para o gate `bun run check:all`. O piloto
`bun run test:containers` é uma alternativa local para executar uma seleção de testes sem subir a stack Compose. A
Requer um daemon Docker acessível. A cada invocação, inicia PostgreSQL 17 e LocalStack 4.14 em portas dinâmicas, cria
seus recursos para os testes e remove os containers ao encerrar. Por padrão, executa seis arquivos: limpeza do banco de teste, criação de filas SQS,
persistência de carteira, redrive do broker, cluster de processos e testes de três processos.

Para passar um ou mais arquivos explicitamente, use `--` antes dos caminhos:

```bash
bun run test:containers -- test/integration/persistence/wallet-persistence.test.ts
```

O tratamento de `SIGINT` e `SIGTERM` foi validado: o runner encerra o processo de teste e tenta parar os containers.
`SIGKILL` enviado ao próprio runner não foi validado e não permite executar a limpeza do processo. Um teste-probe
deliberadamente falho retornou código 1, preservou `test-output.log`, `test-error.log`, `postgres.log`,
`localstack.log` e `failure.txt` no diretório definido por `TESTCONTAINERS_DIAGNOSTICS_DIR`, e removeu os containers.

#### Resultados observados

O piloto foi executado com Bun 1.4.4 e código no commit `9eb46c0b0745879a34d37558a40fe932a90698ac`, usando
PostgreSQL 17 e LocalStack 4.14. Em duas execuções limpas, cada execução passou 20/20 testes, com 94 asserções em
seis arquivos:

| Execução | Inicialização dos containers |  Testes |
| -------- | ---------------------------: | ------: |
| 1        |                      22,96 s |  8,51 s |
| 2        |                      35,53 s | 10,27 s |

Uma comparação com Compose registrou, em uma única medição, 19,01 s para inicialização fria mais 7,82 s de testes;
com a stack Compose já aquecida, os testes levaram 7,82 s. É uma observação pontual, não um benchmark nem uma base
para afirmar que uma opção é mais rápida. CI continua iniciando Compose e executando `check:all`; o piloto não foi
adicionado ao workflow.

## O que a especificação pede e onde cada item é comprovado

A seção 13 do desafio lista os testes obrigatórios. Cada um mapeia para uma suíte:

| Requisito (seção 13)                                       | Comprovado por                                                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Concorrência 1: uma BET enviada 50 vezes em paralelo       | `test/concurrency/hot-wallet.test.ts` (em um processo); `test/concurrency/three-processes.test.ts` (cinquenta requisições em três processos) |
| Concorrência 2: operações competindo por um saldo (§8)     | `test/concurrency/hot-wallet.test.ts`; `test/concurrency/distributed-contention.test.ts`                                                     |
| Concorrência 3: carteiras distintas em paralelo            | `test/concurrency/hot-wallet.test.ts`; `test/concurrency/three-processes.test.ts`                                                            |
| Concorrência 4: três ou mais processos ao mesmo tempo      | `test/concurrency/three-processes.test.ts`; `test/concurrency/distributed-contention.test.ts`                                                |
| Concorrência 5: worker encerrado após commit, antes do ACK | `test/concurrency/three-processes.test.ts`                                                                                                   |
| Concorrência 6: dois publicadores sobre uma outbox         | `test/concurrency/distributed-contention.test.ts` (processos); `test/integration/messaging/outbox-publisher.test.ts` (em um processo)        |
| Concorrência 7: ROLLBACK ou REFUND antes de sua referência | `test/integration/wagering/pending-reference.test.ts`; `test/integration/faults/fault-injection.test.ts`                                     |
| Concorrência 8: reinício com consistência final            | `test/concurrency/three-processes.test.ts`; `test/concurrency/process-crash-and-shutdown.test.ts`                                            |
| §8: vários workers recebem operações de uma carteira       | `test/concurrency/distributed-contention.test.ts`                                                                                            |
| Invariante final: `wallet.balance == ledger`               | verificado no teardown de toda suíte de banco de dados (ver Isolamento), e em cada teste de concorrência                                     |

Cada item é executado contra PostgreSQL real e LocalStack real. Nenhum é executado contra um mock.

## O que cada camada pode substituir

- **Testes unitários** usam objetos de domínio reais. Eles não usam o banco de dados nem a fila.
- **Testes de integração, e2e e concorrência nunca substituem PostgreSQL ou SQS por mocks.** Um teste
  que reivindica atomicidade ou concorrência é executado contra o servidor real. Onde um teste necessita de uma
  falha, ele envolve um componente real (uma unidade de trabalho, um armazenamento de outbox, um transporte) e falha
  exatamente uma vez. O código de produção não contém ganchos de falha.
- **Testes de concorrência** emitem suas operações ao mesmo tempo (`Promise.all`), cada uma em sua própria
  conexão. Nada espera por uma operação antes de iniciar a próxima.
- **As suítes em nível de processo** iniciam processos reais com `Bun.spawn` e os encerram com sinais.
  Elas aguardam prontidão consultando `/health/ready`, e efeitos consultando o banco de dados. Um
  sleep nunca é a sincronização. Temporização aparece apenas onde a visibilidade do SQS é o mecanismo
  sob teste.
- **Pontos de entrada apenas de teste** ficam em `test/support`. Cada um envolve um componente real para parar o
  processo em um ponto escolhido: `crashing-worker.ts` (após commit), `crashing-before-commit-worker.ts`
  (dentro de uma transação, antes do commit) e `slow-worker.ts` (um atraso por transação, para que um lote esteja
  em andamento quando o SIGTERM chegar). Eles usam os pontos de extensão apenas de teste `faults` e `decorateUnitOfWork`
  de `createWorkerRuntime`, que a produção nunca passa.

## Isolamento

- Cada suíte de banco de dados obtém seu próprio banco de dados, criado e migrado no início, e descartado ao
  final, mesmo após uma falha (`test/integration/support/test-database.ts`).
- Cada suíte de SQS obtém suas próprias filas FIFO privadas, com um sufixo aleatório, para que nenhum teste veja
  as mensagens de outro teste (`test/integration/support/sqs-test-queues.ts`).
- Cada processo de um cluster abre seu próprio pool e clientes, e obtém sua própria porta.
- Um teste em nível de processo para todos os workers que iniciou, e um teste que falha é seguido pela terminação forçada de
  qualquer worker deixado para trás. Caso contrário, um worker remanescente consumiria a fila do próximo teste.
  Isso aconteceu uma vez durante a escrita destas suítes.
- Portas e identificadores são aleatórios, permitindo que as suítes sejam executadas em qualquer ordem.
- Long polling é usado onde um teste recebe mensagens. Short polling pode perder mensagens existentes.
  Todo teste que recebe mensagens as confirma, porque uma mensagem FIFO em trânsito bloqueia seu
  grupo. Um teste que não deve esperar atrás de uma mensagem em trânsito de outro teste usa seu próprio grupo.

## O invariante do ledger

Toda suíte de banco de dados verifica, ao ser descartada, se o saldo de cada carteira é igual ao somatório do seu ledger.
Uma violação falha a suíte e aponta as linhas. A suíte de restrições de esquema opta por não participar, porque
escreve linhas diretamente para demonstrar o que o banco de dados recusa, e alguns desses estados quebram o
invariante de propósito.

## Injeção de falhas

| Ponto                                                      | Como é produzido                                                                                                           | Onde                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Após o commit, antes da confirmação SQS                    | o processo do worker é encerrado com código 137 em um ponto de entrada apenas de teste (`test/support/crashing-worker.ts`) | `test/concurrency/three-processes.test.ts`            |
| Dentro de uma transação, antes do commit                   | o processo do worker é encerrado com código 137 após as escritas, antes do commit (`crashing-before-commit-worker.ts`)     | `test/concurrency/process-crash-and-shutdown.test.ts` |
| Um worker encerrado enquanto outro assume a mesma carteira | `SIGKILL` em um dos dois workers no meio de uma contenção                                                                  | `test/concurrency/distributed-contention.test.ts`     |
| Antes do commit, em um processo                            | a unidade de trabalho executa seu trabalho, depois lança um erro antes de fazer o commit                                   | `test/integration/faults/fault-injection.test.ts`     |
| Após aceitação pelo broker, antes de marcar como publicado | o armazenamento da outbox rejeita a marcação uma vez                                                                       | `test/integration/faults/fault-injection.test.ts`     |
| Durante a resolução de uma referência retida               | a unidade de trabalho lança um erro antes do commit, uma vez                                                               | `test/integration/faults/fault-injection.test.ts`     |
| Broker indisponível                                        | o transporte lança um erro                                                                                                 | `test/integration/messaging/outbox-publisher.test.ts` |
| Disputa perdida por uma identidade única                   | duas transações concorrentes, uma perde e tenta novamente                                                                  | `test/concurrency/hot-wallet.test.ts`                 |
| Encerramento gracioso (graceful shutdown)                  | `SIGTERM` para um processo de worker, que deve sair com código 0                                                           | `test/concurrency/three-processes.test.ts`            |
| SIGTERM durante um lote                                    | o lote em andamento é concluído e confirmado; nada é deixado em trânsito                                                   | `test/concurrency/process-crash-and-shutdown.test.ts` |

A recuperação é sempre verificada lendo o estado persistido posteriormente: saldo, ledger, outbox e
fila.

**Não injetado:** um crash do processo da API HTTP dentro de uma transação. A API é coberta em
processo apenas pelos testes de concorrência e por falhas em processo. Uma retentativa de um provedor sob a mesma
chave de idempotência é coberta em processo.

## Evidência de mutação

Uma suíte que passa não é suficiente. Para as regras que sustentam as garantias, o autor quebrou a
regra de propósito e executou a suíte. Um mutante que a suíte não detecta é um achado.

Mutantes desta rodada, executados contra `test/concurrency/distributed-contention.test.ts`:

| Mutante | Regra removida                                                                  | Resultado                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1      | o bloqueio de linha da carteira (`FOR UPDATE` em `findForUpdate`)               | **Eliminado.** A suíte ainda passou, porque a proteção por versão e as retentativas mantêm o estado final correto. O teste sem retentativas falhou: três disputas perdidas. Adicionado à suíte por este motivo.                                                           |
| M2      | a proteção de reversão em `TransactionSettlement` (uma reversão por referência) | **Eliminado**, pelo teste de reembolso e rollbacks e pelo teste sem retentativas.                                                                                                                                                                                         |
| M3      | `SKIP LOCKED` na reivindicação da outbox                                        | **Sobreviveu.** Este mutante é equivalente em termos de segurança. O segundo publicador espera pelo primeiro, depois reavalia o predicado de lease e exclui a linha. `SKIP LOCKED` remove a espera, e nenhum teste mede uma espera. Registrado como uma lacuna conhecida. |
| M4      | o predicado de lease da outbox (`lease_expires_at IS NULL OR ... < now`)        | **Eliminado.** O teste de dois publicadores falhou: 61 leases perdidos, que são reivindicações duplas.                                                                                                                                                                    |

Mutantes de rodadas anteriores, cada um detectado por pelo menos um teste:

- o contexto de precisão monetária e o limite de 18 dígitos;
- a aritmética do ledger e as regras de reversão única;
- a proteção por versão e o bloqueio da carteira (o bloqueio agora também é coberto pelo teste sem retentativas);
- a ordenação de ACK no consumidor e a titularidade de lease no publicador;
- a classificação de falhas e a taxonomia de status;
- o contador de referências ausentes, seu limite e seu bloqueio de carteira;
- o teto do atraso de retentativa de referência (`test/unit/wagering/domain/reference-retry-policy.test.ts`).

Duas fragilidades nos testes foram encontradas e corrigidas. Uma asserção de lease não comprovava nada, descoberta ao
ler o teste. Um teste de disputa entre dois workers não atingiu sua janela de disputa, descoberto quando um mutante
sobreviveu.

Mutantes desta revisão, contra as suítes unitárias, de apostas e de esquema. Cada um altera uma linha de um
arquivo comitado, executa as suítes e restaura o arquivo. A suíte de concorrência não foi executada para estes
mutantes, porque uma execução leva cerca de um minuto.

| Mutante | Alteração                                                     | Resultado                                                                                                  |
| ------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| M1      | a verificação de reversão em `TransactionSettlement` removida | **Eliminado** por 5 testes: um reembolso creditado uma vez, uma reversão por BET, um ROLLBACK de um REFUND |
| M2      | a verificação de referência não liquidada de uma BET removida | **Eliminado** por 4 testes: uma BET paga uma vez, um REFUND após um WIN ou um LOSS                         |
| M3      | a direção de um ROLLBACK não invertida                        | **Eliminado** por 7 testes                                                                                 |
| M4      | a comparação de carteira em `sharesContextWith` removida      | **Eliminado** por 1 teste unitário, uma referência de uma carteira diferente                               |
| M5      | um débito igual ao saldo recusado (comparação estrita)        | **Eliminado** por 2 testes, um teste unitário que debita todo o saldo                                      |

Nenhum mutante desta rodada sobreviveu. Os índices únicos parciais também recusam a segunda linha em M1 e M2
(`wager_one_processed_reversal_per_reference`, `wager_one_processed_settlement_per_reference`), portanto uma
violação da verificação de domínio não pode armazenar um segundo efeito. O banco de dados gera uma violação de unicidade, não a
resposta de negócio (`REFERENCE_ALREADY_REVERSED`), de modo que a resposta de negócio é testada nas suítes de domínio.

Mutantes do contrato de entrada monetária (`fix(money)`), contra `src/shared/domain/money.ts`. Cada um altera
o validador, executa as suítes e é restaurado byte por byte (verificado com `cmp`) antes do seguinte:

| Mutante | Alteração                                          | Resultado                                                                                                                           |
| ------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| N1      | um dígito fracionário aceito novamente (`\d{1,2}`) | **Eliminado.** `money.test.ts`, "rejects an amount with one fractional digit", e os casos E2E para `25.1` (saldo de abertura e BET) |
| N2      | zeros à esquerda aceitos (`\d{1,18}`)              | **Eliminado.** `money.test.ts`, "rejects an amount with a leading zero in the integer part"                                         |

## Carga

`bun run test:load` mede a stack sob um mix de produto, fixado a um número de CPUs. A stack
(três processos de API, dois workers, PostgreSQL, LocalStack) recebe `LOAD_CPUS` CPUs, e o gerador
recebe os demais. Cada etapa envia requisições em um cronograma fixo a uma taxa fixa, e é verificada contra
as restrições em `test/load/thresholds.ts`: taxa de erros, requisições perdidas, latência p95 e p99, atraso do gerador
em p99, esvaziamento da outbox, memória por processo e o invariante `balance == ledger`. A rampa de carga para na
primeira etapa que falhar. O método está em `DECISIONS.md`, grupo N.

| Onde                     | O que é                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `test/load/workload.ts`  | o mix de produto e a requisição de cada operação, como funções puras                    |
| `test/load/metrics.ts`   | percentis, listas de CPUs, analisadores de `/proc` e `docker stats`, CPU por requisição |
| `test/load/records.ts`   | o registro de uma execução, um arquivo JSON por contagem de CPUs                        |
| `test/load/report.ts`    | o relatório, gerado a partir dos registros                                              |
| `test/load/host.ts`      | fixação: quais CPUs cada parte recebe, e os cpusets dos contêineres                     |
| `test/load/load-test.ts` | o executor, que roda a stack e grava o registro                                         |

O planejador e os analisadores são testados unitariamente em `test/unit/load/`, de modo que o mix e a aritmética são
verificados sem um servidor. O executor é verificado por suas execuções.

**Resultados.** Os resultados fixados estão em `docs/load/results/cpus-<N>.json`, um por contagem de CPUs, e o relatório que
os lê é `docs/LOAD_TEST_RESULTS.md`. Os cenários locais (1 a 3 APIs, 1 a 2 workers) estão em `docs/load/local/`, com a linha de base em `docs/LOAD_TEST_BASELINE.md`. No host de sandbox usado para esta revisão (quatro vCPUs), as taxas acordadas
foram:

| CPUs da stack | Taxa acordada | Primeira taxa com falha | O que falhou na primeira taxa com falha        |
| ------------: | ------------: | ----------------------: | ---------------------------------------------- |
|             1 |     100 req/s |               125 req/s | p95 4176 ms, a 83% da CPU                      |
|             2 |     200 req/s |               300 req/s | p95 3408 ms, a 72% da CPU                      |
|             4 |     400 req/s |                 nenhuma | 400 é a etapa máxima configurada, e ela passou |

O teto previsto (as CPUs divididas pela CPU por requisição) foi de 120 req/s em uma CPU e 276 em duas, contra
as primeiras taxas com falha de 125 e 300. O teto para 4 CPUs está acima de 400 nesta medição. As execuções
pareadas de antes e depois, e a linha de base com a qual se comparam, estão em [LOAD_TEST_HISTORY.md](LOAD_TEST_HISTORY.md).

**O que essas execuções comprovam e o que não comprovam:**

- Comprovam que as restrições se mantiveram durante a duração de uma etapa, a uma taxa, com a stack nessa quantidade de CPUs.
- Não comprovam uma execução mais longa. Não há teste de imersão (soak test).
- O gerador é executado nas CPUs que a stack não utiliza. No host de quatro CPUs a stack possui todas as CPUs, e
  o gerador as compartilha, o que o relatório informa.
- A fila é o LocalStack, e o PostgreSQL possui sua configuração padrão, sem réplica.
- O mix é o nosso, e passa apenas por HTTP. A fila de comandos é coberta pelas suítes de concorrência.
- A máquina é uma VM em nuvem. Seus números não constituem uma alegação de capacidade para outra máquina.

## Notas sobre o ambiente

- A stack verificada do Compose é construída com a CA da sandbox, fora do repositório. Consulte
  `ARCHITECTURE.md` seção 14.
- Algumas suítes são sensíveis à temporização por projeto (visibilidade SQS, expiração de lease). Cada uma usa um
  relógio injetado onde possível, e polling delimitado onde não for.

## Adicionado na rodada final de revisão

Cada suíte abaixo foi executada antes da alteração que ela protege, e a falha que produziu foi registrada. Uma verificação que
nunca falhou comprova menos.

| Suíte                                                           | O que comprova                                                                                                                   | Falha observada antes da alteração                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `test/infra/compose-exposure.test.ts`                           | toda porta publicada vincula `127.0.0.1`; o modo protegido publica apenas a borda                                                | 4 de 4 falharam: `hostIp` ausente (todas as interfaces), e PostgreSQL e LocalStack publicados no modo protegido          |
| `test/e2e/authorization-adversarial.test.ts`                    | 28 tentativas de acessar uma rota de operador, transação externa, escrita externa ou chave recusada sob outra grafia             | 1 de 28 falhou: o esquema `bearer` em minúsculas foi recusado. Corrigido; o token ainda diferencia maiúsculas/minúsculas |
| `test/integration/messaging/partial-batch-order.test.ts`        | E1 aceito, E2 recusado, E3 aceito, para uma carteira: o estado da outbox e a ordem na fila real                                  | caracterização: a ordem `1, 3, 2` é a verdade, e está documentada, não escondida                                         |
| `test/unit/worker/worker-http.test.ts`, `worker-config.test.ts` | a superfície HTTP do worker: liveness, métricas durante a execução, métodos, política de cache; a configuração de porta          | antes da implementação: o módulo não carregava, e 7 dos 8 casos de configuração de porta falharam                        |
| `test/concurrency/worker-metrics-live.test.ts`                  | contadores lidos a partir de um processo de worker em execução, antes de parar                                                   | com a superfície removida do worker, falhou após seu timeout de 30 s                                                     |
| `test/unit/openapi/*.test.ts`                                   | o documento OpenAPI é íntegro, descreve as rotas registradas em ambas as direções, e o verificador relata cada divergência       | uma expectativa do verificador estava errada (`integer`, não `number`), corrigida                                        |
| `test/e2e/openapi-responses.test.ts`                            | toda resposta real possui um status documentado e um corpo que valida                                                            | encontrou `seq` como texto, não inteiro. O contrato foi corrigido, não a API                                             |
| `test/unit/site/static-showcase.test.ts`                        | a página estática: sem placeholder, sem carga externa, todo link resolve, links de repositório fixados, números iguais às fontes | encontrou um padrão de placeholder que não aceitava dígitos, então `{{COUNT_E2E}}` seria enviado sem preenchimento       |
| `test/edge/protected-mode.test.ts` (alterado)                   | a borda vincula loopback; PostgreSQL e LocalStack não publicam nada em tempo de execução                                         | a asserção antiga fixava `0.0.0.0`, a exposição sendo corrigida. Corrigido para `127.0.0.1`                              |
