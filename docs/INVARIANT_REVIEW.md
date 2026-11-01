# Revisão de invariantes, restrições e decisões

> **Apêndice.** A revisão do proprietário para cada invariante e restrição. As decisões para as quais solicita confirmação do proprietário
> estão listadas em [ARCHITECTURE.md](../ARCHITECTURE.md) seção 13.

Revisado antes do push deste branch para `main`. A revisão abrange cada invariante da
matriz de requisitos, cada restrição de banco de dados nas migrações e cada
decisão em `docs/adr/` e em `ARCHITECTURE.md` seção 13.

Cada invariante é listado com o ponto que o impõe e o teste que o comprova. Nomes de teste
são aqueles nos arquivos citados. Os identificadores da matriz são descrições curtas, e cada um cita um arquivo que
existe (verificado para esta revisão). Onde a matriz e o código divergiam, o código estava correto e
a matriz foi corrigida.

## 0. A revisão de finalização, no topo do branch

Esta seção repete a revisão sobre o código do branch de finalização. Lista cada invariante citado no enunciado, o
ponto que o impõe e o teste que o comprova no HEAD. Onde uma verificação foi feita lendo o código, o
texto assim informa. Todo teste citado aqui passou na validação final.

| Invariante                                                 | Imposto por                                                                                                      | Comprovado por                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Saldo nunca negativo                                       | `Wallet.canDebit` antes do débito; `balance >= 0` no banco de dados                                              | `wallet.test.ts`; `schema-constraints`; `hot-wallet: mixed operations`                                  |
| Créditos e débitos não duplicados                          | uma liquidação processada por referência (índice único parcial); uma linha de ledger por (wallet, transaction)   | `hot-wallet`, `distributed-contention`, `duplicate-deliveries`                                          |
| Ledger imutável                                            | gatilhos que recusam UPDATE, DELETE e TRUNCATE                                                                   | `schema-constraints: ledger is immutable`                                                               |
| Unicidade por provedor e identidade externa                | `UNIQUE (provider, idempotency key)` e `UNIQUE (provider, external id)`                                          | `schema-constraints`; `distributed-contention: one key, three payloads`                                 |
| Hash canônico do payload                                   | chaves ordenadas e sem espaços em branco, em todos os níveis; SHA-256 desse formato; sem metadados de transporte | `wager-payload-hash.test.ts`: a codificação, o digest, a ordem dos campos e uma referência ausente      |
| Referências fora de ordem                                  | `PENDING_REFERENCE` com cronograma persistido; o worker relê sob o lock de carteira                              | `pending-reference: six workers racing over six held refunds`                                           |
| Reversões                                                  | uma reversão por referência, seja qual for seu tipo; descoberto resulta em `REVERSAL_WOULD_OVERDRAW`             | `process-wager-transaction: one reversal per bet`; `distributed-contention: a refund and two rollbacks` |
| Concorrência através de três ou mais processos             | o lock de linha da carteira, a proteção por versão e as restrições de unicidade                                  | `three-processes`; `distributed-contention`                                                             |
| Atomicidade de carteira, ledger, transação, inbox e outbox | uma unidade de trabalho; as linhas de outbox e inbox são gravadas nela                                           | `fault-injection: a crash before commit leaves no trace`                                                |
| Respostas HTTP coerentes com o estado financeiro           | `statusOf` mapeia cada estado para um status; um replay retorna o snapshot armazenado                            | `wagering-http`; o contrato de replay em `ARCHITECTURE.md` seção 6                                      |

Alterações nesta rodada, cada uma com seu commit: a fila recusa um id de carteira que não seja UUID assim como o HTTP faz (`d437452`); uma
cópia de dead-letter mantém uma cópia dentro da janela do broker (`ebc9589`); uma duplicata que aguarda pelo lock não grava
uma segunda linha na inbox (`a10fd11`); a outbox ordena um lote reivindicado pelo horário de vencimento (`89b7bc1`); o caminho de lock faz menos
viagens de ida e volta (round trips), e sua consulta de desfecho utiliza os índices parciais (`9e8dabe`). Cada alteração possui um teste que falhava antes
dela e passa após ela.

Verificado por leitura de código, não por teste: que `Wallet.credit` não verifica por si próprio o valor máximo do banco de dados (a
liquidação verifica `canCredit` primeiro, e o banco recusa o excedente); que o worker de referências adquire o lock da carteira
antes de reler uma transação retida; que o consumidor confirma (ACK) apenas após o retorno da unidade de trabalho.

## 1. Defeitos encontrados nesta revisão e suas correções

| #   | Defeito                                                                                | Correção                                                                                                                                             | Commit    |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Dois WINs em uma mesma BET creditavam a carteira: uma BET podia pagar duas vezes       | Um resultado PROCESSED por BET: verificação na liquidação e índice único parcial `wager_one_processed_settlement_per_reference`                      | `ce1cb62` |
| 2   | Um REFUND após um WIN ou LOSS da mesma BET era aplicado                                | REFUND apenas para uma BET sem resultado (`REFERENCE_ALREADY_SETTLED`)                                                                               | `ce1cb62` |
| 3   | Um WIN ou LOSS podia omitir sua BET, inviabilizando vincular resultado à BET           | A migração 3 exigia a BET para WIN e LOSS. A migração 6 torna isso opcional, conforme a especificação diz, mantendo a validação se informada. Ver D1 | `ce1cb62` |
| 4   | O banco de dados aceitava valor zero para todos os tipos                               | `wager_amount_shape`: positivo, exceto LOSS                                                                                                          | `f9eb95b` |
| 5   | O banco de dados não verificava se uma referência pertencia à mesma rodada             | `wager_reference_round_key` e a chave estrangeira de referência incluem `round_id`                                                                   | `f9eb95b` |
| 6   | O banco de dados não verificava se o lançamento tinha a moeda da carteira              | `ledger_wallet_currency_fk`                                                                                                                          | `f9eb95b` |
| 7   | Uma regra em rascunho vinculava jogador e moeda de transação à carteira                | Revertida. Divergência resulta em linha REJECTED persistida por projeto (ARCHITECTURE seção 13). O domínio verifica                                  | `f9eb95b` |
| 8   | Contêiner de API ou worker com crash permanecia parado (sem restart policy)            | `restart: unless-stopped` para `api` e `worker`                                                                                                      | `8e807a8` |
| 9   | A API aceitava qualquer cliente, e qualquer um podia citar qualquer provedor           | Chaves de API com dois papéis e escopo de provedor (ADR 0007)                                                                                        | `6ff6891` |
| 10  | Crash em nível de processo antes do commit e SIGTERM durante lote não eram comprovados | Ambos agora executam em processos de worker reais. Nenhum demandou mudança em produção                                                               | `26cfc21` |

Os defeitos 1 e 2 eram créditos duplicados. O defeito 3 tornava 1 e 2 impossíveis de verificar. Os defeitos 4 a 6
eram regras que apenas o domínio impunha. O defeito 7 foi capturado por dois testes existentes, não por
raciocínio teórico, razão pela qual a verificação completa (gate) executou antes de cada commit.

## 2. Decisões que dependem do proprietário

Estas são interpretações, não fatos da especificação. Cada uma está documentada em ARCHITECTURE
seção 13, e cada uma altera o comportamento observado por um provedor.

| #   | Decisão                                                                                                                                 | Motivo                                                                                                                      | Risco caso o proprietário discorde                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | WIN e LOSS podem omitir referência; se citarem BET, validam o contexto completo. A especificação torna a referência opcional (6.3, 7).  | Não se infere associação por roundId ou heurística. WIN sem referência não demonstra unicidade da liquidação por BET.       | Confirmado em 2026-11-01. Um WIN sem referência não pode ser vinculado à BET nem usado para provar unicidade da liquidação por BET.                                              |
| D2  | ROLLBACK aplica-se em qualquer estado da transação que reverte, com ou sem resultado.                                                   | Confirmado em 2026-11-01: ROLLBACK é reversão individual da transação.                                                      | Após um WIN, o ROLLBACK da BET devolve a aposta e o WIN continua creditado; efeito econômico aceito em 2026-11-01. O WIN precisa de seu próprio ROLLBACK; sem cascata implícita. |
| D3  | REFUND apenas para BET PROCESSED sem resultado; após WIN, LOSS ou reversão conflitante é recusado. BET não reabre após desfazer REFUND. | Confirmado em 2026-11-01.                                                                                                   | Um REFUND que chega após um WIN é recusado. O provedor deve enviar um ROLLBACK do WIN em vez disso.                                                                              |
| D4  | Uma referência admite no máximo uma reversão efetiva, seja qual for o tipo. A regra 4 diz "pelo mesmo tipo de operação".                | Interpretação adicional confirmada em 2026-11-01; não é o texto literal da especificação.                                   | Evita REFUND seguido de ROLLBACK creditar a aposta duas vezes; aplicada por `wager_one_processed_reversal_per_reference`.                                                        |
| D5  | Autenticação é via chaves de API com dois papéis, não um provedor de identidade externo. A especificação prevê um IdP (seção 2).        | ADR 0007: um esquema simples de que o projeto precisa. Um contêiner keycloak ou zitadel foi julgado pesado para este build. | Chaves não expiram, não rotacionam em cronograma, nem trafegam via TLS neste build. Um deploy em produção requer o IdP sugerido pela especificação.                              |
| D6  | Divergência de moeda ou jogador resulta em linha REJECTED persistida, verificada apenas pelo domínio.                                   | Auditabilidade (ARCHITECTURE seção 13). Uma chave estrangeira recusaria a linha.                                            | Um escritor que contornasse o domínio poderia persistir uma linha divergente sem código de recusa. Não existe tal escritor no código.                                            |

**Reavaliação de D2, D3 e D4 (nesta revisão).** Cada uma foi checada contra o código e os testes e confirmada em 2026-11-01,
e contra o invariante global de que nenhum crédito é duplicado.

- **D4, uma vez por referência.** Mantida. Lida literalmente, a regra 4 permite um REFUND e depois um ROLLBACK de uma
  BET, o que credita a aposta duas vezes, prevalecendo portanto o invariante. A leitura mais estrita tem uma consequência
  que agora está testada: um reembolso revertido por rollback não libera sua BET, e uma segunda reversão da BET resulta em
  `REFERENCE_ALREADY_REVERSED`. Uma regra mais refinada que calculasse reversões líquidas poderia permitir esse caso sem
  crédito duplicado. Ela não foi construída, pois nenhum requisito a solicita.
- **D3, um REFUND apenas para uma BET sem resultado.** Mantida, e agora imposta também pelo banco de dados
  (migração 8). Um reembolso e um resultado não podem ambos ser processados para uma mesma BET, em qualquer ordem. A
  ordem inversa (um WIN após um reembolso) é recusada pela regra de reversão.
- **D2, um ROLLBACK em qualquer estado.** Mantida como registrada, e seu efeito econômico foi aceito em 2026-11-01. Após um WIN, fazer rollback da BET devolve a aposta e mantém o ganho, permitindo ao jogador manter
  ambos. Nenhum crédito é duplicado por identidade ou valor: a aposta retorna uma vez (D4), e o ganho é
  creditado uma vez. A alternativa é recusar o ROLLBACK de uma BET que possua um WIN processado, para que o
  provedor reverta o WIN primeiro, assim como D3 faz para reembolsos. A confirmação de 2026-11-01 aceita esse efeito: reversão individual, sem cascata implícita.

Os caminhos de crédito duplicado que restam decorrem do WIN sem referência (D1): um WIN que não cita BET pode ser
creditado novamente se o provedor o reenviar sob um novo id externo. Isso é por projeto, porque cada
id externo é uma operação (ARCHITECTURE seção 7).
| D7 | Um worker reinicia após crash com pausa fixa de um segundo. Não há backoff exponencial para os loops. | Simples, e cada loop registra sua falha em log. | Durante uma indisponibilidade longa, cada loop registra log uma vez por segundo. |

## 3. Invariantes

Pontos de imposição: **DB** é uma restrição de banco de dados, **Domain** é uma entidade ou objeto de valor,
**Unit of work** é a transação e o lock de carteira, **Queue** é o consumidor ou publicador,
**Test-only** é um ponto de extensão que o código de produção nunca acessa.

### 3.1 Dinheiro, idempotência e concorrência

| ID     | Invariante                                       | Imposto por                                                                 | Comprovado por                                                                                                                                         |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| INV-01 | Nenhum crédito ou débito duplicado               | Unidade de trabalho (lock de carteira), chaves únicas no DB, domínio        | `test/concurrency/hot-wallet.test.ts` (exatamente uma BET de 80.00 sobre 100.00, carteira disputada mista); `test/concurrency/three-processes.test.ts` |
| INV-02 | Ledger e saldo sempre concordam                  | Domínio (`Wallet.debit`, `credit`), CHECK aritmético no DB, reconciliação   | `test/integration/persistence/wallet-persistence.test.ts`; `test/e2e/queries-http.test.ts` (reconciliação)                                             |
| INV-03 | Dinheiro nunca é um `number`                     | Tipo `Money`, `AMOUNT_PATTERN`, `NUMERIC(20,2)`                             | Testes de dinheiro em `test/unit/shared/domain`, `rejects a JavaScript number`                                                                         |
| INV-04 | Idempotência é persistente, não em memória       | Chave única no DB `(provider_id, idempotency_key)`                          | `test/integration/wagering/process-wager-transaction.test.ts`, `a repeated identical request replays`                                                  |
| INV-05 | Nada é publicado antes do commit                 | Outbox gravada na mesma transação                                           | `test/concurrency/three-processes.test.ts`, `test/integration/messaging/wager-command-consumer.test.ts`                                                |
| INV-06 | Ledger nunca é sobrescrito ou excluído           | Gatilho `wallet_ledger_entries_no_update_or_delete`, gatilho de no-truncate | `test/integration/schema/schema-constraints.test.ts`, `is append-only: UPDATE / DELETE / TRUNCATE is refused`                                          |
| INV-07 | Nenhum lock global entre carteiras               | Lock de linha em uma única carteira                                         | `test/concurrency/hot-wallet.test.ts`, `distinct wallets operated in parallel`                                                                         |
| INV-08 | Nenhuma leitura-cálculo-atualização desprotegida | `FOR UPDATE` mais proteção por versão em `save`                             | `test/integration/persistence`, `refuses a save whose expected version is stale`                                                                       |
| INV-09 | Correto com múltiplas instâncias                 | Lock de linha e restrições no DB, não em memória                            | `test/concurrency/three-processes.test.ts`                                                                                                             |
| INV-10 | O banco de dados recusa linhas inválidas         | Restrições listadas na seção 4                                              | `test/integration/schema/schema-constraints.test.ts` (as verificações neste arquivo)                                                                   |
| INV-11 | A unidade de concorrência é a carteira           | `FOR UPDATE` na linha da carteira, obtido primeiro                          | `test/concurrency/hot-wallet.test.ts`                                                                                                                  |

### 3.2 Carteira e ledger

| ID     | Invariante                                                     | Imposto por                                                           | Comprovado por                                                                                             |
| ------ | -------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| WAL-01 | No máximo uma carteira por jogador e moeda                     | Chave no DB `wallets_player_currency_key`                             | `allow only one wallet per player and currency`                                                            |
| WAL-02 | Saldo nunca é negativo                                         | CHECK no DB `balance >= 0`, domínio `canDebit`                        | `reject a negative balance`, `refuses to debit more than the balance`                                      |
| WAL-03 | Toda alteração de saldo tem lançamento no ledger, e vice-versa | Unidade de trabalho (carteira, ledger e outbox juntos), reconciliação | `the ledger reconstructs the materialized balance after mixed movements`                                   |
| WAL-04 | A moeda da operação é a moeda da carteira                      | Domínio (`WALLET_CURRENCY_MISMATCH`), FK do ledger no DB              | `a currency other than the wallet currency is REJECTED`, `rejects a debit in a different currency`         |
| WAL-05 | `version` inicia em 1 e muda apenas com alteração de saldo     | Domínio, CHECK no DB `version >= 1`                                   | `a zero initial balance opens at version 1`, `a zero-amount movement is rejected`                          |
| WAL-06 | Nenhuma atualização perdida sob concorrência                   | Proteção por versão e `FOR UPDATE`                                    | `test/concurrency/hot-wallet.test.ts`                                                                      |
| LED-01 | Ledger é imutável e somente-anexação                           | Gatilhos                                                              | `is append-only: UPDATE is refused`, `DELETE is refused`, `TRUNCATE is refused`                            |
| LED-02 | `balanceBefore ± money == balanceAfter`                        | Domínio `WalletLedgerEntry.create`, CHECK no DB `ledger_arithmetic`   | `rejects an entry whose arithmetic does not balance`                                                       |
| LED-03 | No máximo um lançamento por carteira por transação             | Chave no DB `ledger_one_entry_per_wallet_transaction`                 | `test/integration/schema`, `one entry per transaction`                                                     |
| LED-04 | LOSS e REJECTED não gravam lançamento no ledger                | Domínio e liquidação                                                  | `a LOSS is processed without moving the balance, the ledger`, `a BET the balance cannot cover is REJECTED` |

### 3.3 Transações e regras de negócio

| ID     | Invariante                                                                                    | Imposto por                                                                  | Comprovado por                                                                                         |
| ------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| WTX-01 | Os seis tipos, e apenas esses                                                                 | CHECK no DB `kind`, `KIND_RULES`                                             | `transaction kinds`                                                                                    |
| WTX-02 | Estados explícitos, e estados terminais não reabrem                                           | Máquina de estados do domínio, CHECK no DB `wager_status_shape`              | `PENDING → PROCESSED records the resulting balance`, `markPendingReference is only valid from PENDING` |
| WTX-03 | OPENING nunca é submetida por um provedor ou mensagem de fila                                 | `isExternallySubmittable`, tabela `externallySubmittable`                    | `OPENING is internal and cannot be submitted externally`                                               |
| WTX-04 | Mesma chave com payload diferente é conflito, nunca replay                                    | Hash do payload, chave única no DB                                           | `the same idempotency key with a different payload is a conflict`                                      |
| BR-01  | BET debita e recusa saldo insuficiente                                                        | Domínio e liquidação                                                         | `a BET the balance cannot cover is REJECTED`                                                           |
| BR-02  | WIN credita; cita a BET que liquida quando possível (D1)                                      | `KIND_RULES`, CHECK no DB `wager_reference_shape`                            | `a WIN credits the wallet`, `a WIN or LOSS without the reference of its BET is an invalid transaction` |
| BR-03  | LOSS não altera saldo; cita sua BET quando possível (D1)                                      | `KIND_RULES`, CHECK no DB `wager_reference_shape`                            | `a LOSS is processed without moving the balance`                                                       |
| BR-04  | REFUND reverte uma BET uma vez, e apenas uma sem resultado (D3)                               | Liquidação, `mustBeUnsettled`, `wager_one_processed_reversal_per_reference`  | `a REFUND is refused once the BET has a WIN`, `a REFUND of a BET without a result is applied`          |
| BR-05  | ROLLBACK reverte BET, WIN ou REFUND uma vez, em qualquer estado (D2, D4)                      | Liquidação, `wager_one_processed_reversal_per_reference`                     | `a ROLLBACK applies after the BET has a WIN`, `a ROLLBACK applies after the BET has a LOSS`            |
| BR-06  | Referência coincide em provedor, jogador, carteira, moeda, rodada, valor e tipo               | Domínio (`evaluateReference`), FKs compostas no DB (provider, wallet, round) | `a reference that is itself still pending`, `a REFUND may only reference a BET`                        |
| BR-07  | Valor da reversão é igual ao valor da referência                                              | Domínio (`amountMustMatch`)                                                  | `a reversal must match the referenced amount exactly`                                                  |
| BR-08  | REJECTED não altera saldo e não grava no ledger                                               | Liquidação                                                                   | `a BET the balance cannot cover is REJECTED, with no balance or ledger effect`                         |
| BR-09  | Replay devolve o resultado original, com o saldo observado na época                           | `resulting_balance` armazenado                                               | `a repeated identical request replays the original result and the balance seen back then`              |
| BR-10  | Referência ausente retém a transação como PENDING_REFERENCE                                   | Liquidação, `markPendingReference`                                           | `a REFUND that arrives before its BET waits as PENDING_REFERENCE`                                      |
| BR-11  | Reversão que causaria descoberto resulta em REVERSAL_WOULD_OVERDRAW, não INSUFFICIENT_BALANCE | Liquidação                                                                   | `a ROLLBACK of a WIN the balance has already spent is REVERSAL_WOULD_OVERDRAW`                         |
| BR-12  | Interpretações adicionais estão documentadas                                                  | `ARCHITECTURE.md` seção 13                                                   | A seção 13 é revisada na seção 2 deste documento                                                       |
| BR-13  | Uma BET tem no máximo um resultado PROCESSED (WIN ou LOSS)                                    | Liquidação, `wager_one_processed_settlement_per_reference`                   | `a BET pays once`, `a LOSS cannot be recorded on a BET that already has a WIN`                         |

### 3.4 Referências, retentativas e outbox

| ID              | Invariante                                                      | Imposto por                                                         | Comprovado por                                                                                                           |
| --------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| REF-01          | Transações retidas tentam novamente com backoff exponencial     | `referenceRetryDelayMs`, coluna no DB `reference_next_attempt_at`   | `retries are scheduled with backoff`, `test/unit/wagering/domain/reference-retry-policy.test.ts` (mutação no teto falha) |
| REF-02          | O limite de tentativas é explícito                              | `MAX_REFERENCE_ATTEMPTS = 6`, coluna no DB `reference_attempts`     | `after the attempt limit the transaction is REJECTED with REFERENCE_NOT_FOUND`                                           |
| REF-03          | Referência esgotada é REJECTED e anunciada                      | Liquidação                                                          | `after the attempt limit the transaction is REJECTED ... and announced`                                                  |
| REF-04          | Reinício e crash durante resolução aplicam o efeito uma vez     | Cronograma persistido, rollback de transação                        | `a restarted worker continues the persisted schedule`; `fault: a crash while resolving a held reference rolls back`      |
| MSG-01          | O consumidor da fila utiliza o caso de uso HTTP                 | Mesmo `ProcessWagerTransaction`                                     | `test/integration/messaging/wager-command-consumer.test.ts`                                                              |
| MSG-02          | A inbox deduplica por consumidor e id de mensagem               | Chave primária no DB `(consumer_name, message_id)`, hash do payload | `deduplicates inbox messages by consumer and message id`                                                                 |
| MSG-03          | ACK apenas após o commit                                        | Ordem no consumidor                                                 | `a crash after commit and before the acknowledgement is recovered by redelivery`                                         |
| MSG-04          | Falhas de negócio, transitórias e permanentes são classificadas | `failure-classification.ts`                                         | `a malformed message is dead-lettered` (permanente); `a transient failure leaves the message in the queue` (transitória) |
| MSG-05          | Limite de entregas antes da DLQ                                 | Redrive do broker `maxReceiveCount = 10`                            | `the command queue redrives to the dead-letter queue after ten deliveries`                                               |
| MSG-06          | SIGTERM conclui ou devolve o lote                               | Sinal de parada de `runWorker`                                      | `SIGTERM stops the worker gracefully with exit code 0`                                                                   |
| MSG-07          | Reentrega não duplica um efeito                                 | Inbox e idempotência                                                | `a redelivered message with the same messageId does not apply its effect twice`                                          |
| MSG-08          | Uma falha transitória não para o worker                         | Proteção `runPass` em `run-worker.ts`                               | `a failing pass in any loop is logged, and that loop keeps running`                                                      |
| MSG-09          | Um crash antes do commit não deixa vestígios                    | Rollback de transação                                               | `a worker killed inside a transaction, before commit, leaves no trace`                                                   |
| MSG-10          | Um SIGTERM durante um lote conclui o lote                       | Parada verificada entre lotes                                       | `a worker stopped with SIGTERM during a batch`                                                                           |
| OUT-01 a OUT-04 | Os quatro eventos são publicados, uma vez cada, após commit     | Outbox gravada na transação                                         | `publishes each committed event once, and marks it published`                                                            |
| OUT-05          | O envelope é uma classe abstrata tipada                         | `IntegrationEvent`                                                  | `serializes identity, correlation, ISO time, version and event type`                                                     |
| OUT-06          | Publicadores concorrentes reivindicam eventos disjuntos         | `FOR UPDATE SKIP LOCKED`, lease                                     | `concurrent publishers claim disjoint events, so no event is sent twice`                                                 |
| OUT-07          | At-least-once com um id de evento estável                       | Chave primária da outbox, id de deduplicação SQS                    | `a crash after the broker accepted an event ... republishes with the same event id`                                      |
| OUT-08          | Leases expirados são recuperados                                | `claimDue` com `lease_until`                                        | `an event leased by a crashed publisher is published once its lease expires`                                             |

### 3.5 API, observabilidade e autenticação

| ID              | Invariante                                                                              | Imposto por                          | Comprovado por                                                                                           |
| --------------- | --------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| API-01 a API-11 | Códigos de status, erros, cursores, reconciliação e integridade (ARCHITECTURE seção 10) | Controladores, `toErrorResponse`     | `test/e2e/*.test.ts` (32 testes)                                                                         |
| API-11          | Prontidão verifica PostgreSQL e SQS, e falha quando SQS está inacessível                | `HealthService`                      | `readiness is 503 and names the failing dependency when SQS is unreachable`                              |
| OBS-01          | Logs estruturados com os campos de correlação                                           | `OperationLog`, `formatOperationLog` | `test/unit/observability/structured-log.test.ts`                                                         |
| OBS-02          | Nenhum valor ou payload em logs; erros registrados por classe e código, nunca mensagem  | Tipo `OperationLog`, `describeError` | `cannot carry a money field`, `gives the class name and the code of an error, and never its message`     |
| OBS-03          | Contadores para status, duplicatas, retentativas, DLQ, conflitos de lock, lag, latência | `MetricsRegistry`                    | `counts processed transactions and idempotent replays of this process` (`test/e2e/metrics-http.test.ts`) |
| OBS-04          | Liveness e prontidão são separados                                                      | `HealthController`                   | `liveness is 200 and does not depend on any dependency`                                                  |
| AUTH-01         | Toda rota requer uma chave válida, exceto saúde                                         | `ApiKeyGuard`, `@Public()`           | `test/e2e/auth-http.test.ts`                                                                             |
| AUTH-02         | Um provedor age apenas pelo seu próprio id de provedor                                  | `requireProviderScope`               | `test/e2e/auth-http.test.ts`, `test/concurrency/three-processes.test.ts`                                 |
| AUTH-03         | Rotas de carteira e métricas são apenas para operadores                                 | `@OperatorOnly()`, guard             | `a provider key cannot open a wallet or read metrics: 403 FORBIDDEN`                                     |
| AUTH-04         | A chave é armazenada apenas como hash SHA-256, e uma chave revogada é recusada          | `api_clients.key_hash`, `revoked_at` | `no column of any row holds the plaintext key`, `a revoked key is no longer accepted`                    |

## 4. Restrições de banco de dados

| Tabela                  | Restrição                                                                               | Regra                                                                                        | Comprovado por                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `wallets`               | `wallets_player_currency_key` (única)                                                   | uma carteira por jogador e moeda                                                             | verificação WAL-01                                                                                              |
| `wallets`               | CHECK de `currency`, `balance >= 0`, `version >= 1`                                     | formato ISO, saldo não negativo, versão inicia em 1                                          | verificações WAL-02, WAL-05                                                                                     |
| `wallets`               | `wallets_id_currency_key` (única)                                                       | destino da FK de moeda do ledger (migração 5)                                                | verificação de moeda do ledger                                                                                  |
| `wager_transactions`    | `wager_external_identity_key`, `wager_idempotency_key`                                  | id externo único e chave de idempotência única por provedor                                  | verificações INV-04, WTX-04                                                                                     |
| `wager_transactions`    | `wager_reference_target_key`, `wager_reference_wallet_key`, `wager_reference_round_key` | chaves únicas usadas como destinos de FKs compostas                                          | verificações de referência                                                                                      |
| `wager_transactions`    | `wager_reference_fk` (`reference_transaction_id, provider_id, wallet_id, round_id`)     | uma referência é do mesmo provedor, carteira e rodada (migração 5)                           | `a reference must be a transaction of the same round`; `rejects a reference to a transaction of another wallet` |
| `wager_transactions`    | `wager_reference_shape`                                                                 | REFUND e ROLLBACK informam referência; BET e OPENING não; WIN e LOSS podem (migração 6)      | `a WIN or a LOSS may omit the reference of its BET`                                                             |
| `wager_transactions`    | `wager_resolved_reference_shape`                                                        | uma referência resolvida possui seu id externo                                               | verificação em `schema-constraints.test.ts`                                                                     |
| `wager_transactions`    | `wager_status_shape`                                                                    | PROCESSED exige `processed_at` e um saldo; REJECTED e FAILED exigem código                   | `rejects a PROCESSED transaction without processed_at and resulting balance`                                    |
| `wager_transactions`    | `wager_pending_reference_schedule`                                                      | uma linha retida tem próximo horário de busca e o saldo com que foi retida (migração 7)      | verificações de referência                                                                                      |
| `wager_transactions`    | `wager_processed_reversal_is_resolved`                                                  | uma reversão PROCESSED cita sua referência                                                   | `rejects a PROCESSED rollback whose reference was never resolved`                                               |
| `wager_transactions`    | `wager_amount_shape` (migração 5)                                                       | valor > 0, exceto LOSS, que pode ser zero                                                    | `a zero amount is refused for every kind except LOSS`                                                           |
| `wager_transactions`    | `wager_one_processed_reversal_per_reference`                                            | um REFUND ou ROLLBACK com status PROCESSED por referência (migração 2)                       | `allows only one PROCESSED reversal per reference, whatever its kind`                                           |
| `wager_transactions`    | `wager_one_processed_settlement_per_reference`                                          | um WIN, LOSS ou REFUND com status PROCESSED por BET (migração 3; migração 8 adiciona REFUND) | `allows only one PROCESSED result per BET`                                                                      |
| `wallet_ledger_entries` | `ledger_seq_key`, `ledger_one_entry_per_wallet_transaction`                             | sequência única, um lançamento por carteira e transação                                      | verificação LED-03                                                                                              |
| `wallet_ledger_entries` | `ledger_transaction_in_same_wallet_fk`                                                  | a transação do lançamento pertence à sua carteira                                            | verificações do ledger                                                                                          |
| `wallet_ledger_entries` | `ledger_wallet_currency_fk` (migração 5)                                                | o lançamento possui a moeda de sua carteira                                                  | `a ledger entry takes the currency of its wallet`                                                               |
| `wallet_ledger_entries` | `ledger_arithmetic`, `amount > 0`, saldos `>= 0`                                        | `balance_before ± amount = balance_after`                                                    | verificação LED-02                                                                                              |
| `wallet_ledger_entries` | gatilhos: sem atualização, sem exclusão, sem truncate                                   | somente-anexação                                                                             | verificações INV-06, LED-01                                                                                     |
| `inbox_messages`        | chave primária `(consumer_name, message_id)`                                            | um registro por consumidor e mensagem                                                        | MSG-02                                                                                                          |
| `outbox_messages`       | chave primária (id do evento), `attempts >= 0`                                          | uma linha por evento                                                                         | OUT-07                                                                                                          |
| `api_clients`           | `api_client_role_shape`                                                                 | PROVIDER informa provedor, OPERATOR não informa nenhum (migração 4)                          | `a PROVIDER must name a provider, and an OPERATOR must not`                                                     |
| `api_clients`           | `key_hash` UNIQUE e CHECK (64 hex)                                                      | um cliente por chave, e o valor armazenado é um resumo SHA-256                               | `two clients cannot share a key hash`                                                                           |
| `api_clients`           | CHECK de `name` (não vazio), CHECK de `role`                                            | um cliente tem um nome e um papel conhecido                                                  | testes de integração e o teste da CLI                                                                           |

Não imposto pelo banco de dados, e o porquê:

- **O jogador e moeda de uma transação contra sua carteira.** Uma linha REJECTED mantém o jogador
  e moeda com os quais foi submetida (decisão D6). O domínio os verifica, e a linha rejeitada
  é mantida.
- **A cadeia de saldo entre linhas do ledger** (`balance_before` é igual ao `balance_after` anterior).
  As escritas a produzem e a reconciliação a verifica. Uma restrição entre linhas exigiria um gatilho
  a cada inserção, e não impediria um segundo escritor de ler dados defasados.
- **A máquina de estados de `wager_transactions`.** A tabela é atualizada no local, não sendo portanto
  somente-anexação como o ledger. O domínio permite apenas as transições listadas.

## 5. Decisões

| Decisão                                                                   | Onde                 | Status                                                                                              |
| ------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| ADR 0001: lock pessimista de linha na carteira                            | `docs/adr/0001`      | Implementado. Testado pelas suítes de carteira sob concorrência (hot-wallet)                        |
| ADR 0002: dinheiro como string decimal, `NUMERIC(20,2)`                   | `docs/adr/0002`      | Implementado. `Money` possui precisão 40                                                            |
| ADR 0003: escopo de idempotência e hash do payload                        | `docs/adr/0003`      | Implementado. Teste com hash padrão (golden hash)                                                   |
| ADR 0004: outbox com reivindicação e lease, at-least-once                 | `docs/adr/0004`      | Implementado. Testado pelas suítes de outbox e de três processos                                    |
| ADR 0005: retenção para referências ausentes, com retentativas limitadas  | `docs/adr/0005`      | Implementado. Seis tentativas; atraso limitado a cinco minutos (testado)                            |
| ADR 0006: autenticação postergada                                         | `docs/adr/0006`      | Substituído por ADR 0007                                                                            |
| ADR 0007: chaves de API, dois papéis, escopo de provedor                  | `docs/adr/0007`      | Implementado. Decisão D5 em aberto para o proprietário                                              |
| ARCHITECTURE seção 13: uma reversão por referência (D4)                   | `ARCHITECTURE.md`    | Implementado. Confirmado em 2026-11-01; interpretação adicional à regra 4                           |
| Seção 13: WIN e LOSS podem citar sua BET (D1)                             | `ARCHITECTURE.md`    | Implementado. Confirmado em 2026-11-01; WIN sem referência não demonstra unicidade por BET          |
| Seção 13: um resultado por BET, REFUND apenas sem resultado (D3)          | `ARCHITECTURE.md`    | Implementado. Confirmado em 2026-11-01                                                              |
| Seção 13: ROLLBACK em qualquer estado (D2)                                | `ARCHITECTURE.md`    | Implementado. Efeito econômico confirmado em 2026-11-01; reversão individual, sem cascata implícita |
| Seção 13: divergência de jogador e moeda é linha REJECTED persistida (D6) | `ARCHITECTURE.md`    | Implementado                                                                                        |
| Seção 13: OPENING sob o id interno de provedor `system`                   | `ARCHITECTURE.md`    | Implementado                                                                                        |
| Compose reinicia api e worker (não coberto por teste)                     | `docker-compose.yml` | Apenas configuração. Verificado com `docker compose config`                                         |

## 6. Lacunas remanescentes e o que significam

- **Um crash em nível de processo da API dentro de uma transação** não é testado. O fluxo HTTP é
  coberto em processo, e a retentativa de um provedor sob a mesma chave de idempotência é testada.
- **Chaves não expiram nem rotacionam**, e a API atende em HTTP simples. Uma implantação real deve adicionar TLS
  e um provedor de identidade (D5).
- **Mensagens da fila não são autenticadas.** O desafio trata a fila como um canal interno.
  Na AWS isso é uma política IAM, que este build não configura.
- **Carga não é testada.** As suítes de concorrência comprovam corretude, não vazão (throughput). _Nota: esta revisão é anterior aos testes de carga; a vazão medida está em [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md)._
- **Métricas são por processo**, sem agregação.
- **A reconciliação é sob demanda**, sem cronograma automatizado.
- **Os identificadores restantes da matriz são descritivos.** Cada um cita um arquivo que existe, e os testes
  mencionados neste documento foram verificados por nome.

## 7. Como esta revisão foi checada

- Cada caminho de arquivo citado em `docs/` e `ARCHITECTURE.md` foi verificado quanto à existência: 0 ausentes.
- Os testes nomeados nas seções 3 e 4 foram verificados contra os arquivos de teste.
- `bun run check:all` passou no código final antes do push: 178 testes unitários, 111 de integração, 21
  de concorrência e 32 testes e2e.
- Cada regra de banco de dados foi verificada com um probe que falha antes de sua migração existir e passa
  depois dela (`schema-constraints.test.ts`).
