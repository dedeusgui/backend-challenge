# Auditoria final

> Versão principal em português. A cópia de referência em inglês é [AUDITORIA_FINAL.en.md](AUDITORIA_FINAL.en.md).

Registro da auditoria final no escopo histórico revisado, com código, métodos de verificação, barra de avaliação, achados, decisões então abertas, lacunas e revisões simuladas.

Os dados brutos de execução não são versionados no repositório.

## 1. Código auditado

- **Commit revisado naquela auditoria:** `bffe108`
- **Comando de obtenção:** `git log -1 --format=%h -- src test`
- **Data:** 2026-11-01 (19:21:49 -0300)

Este é o escopo histórico daquela revisão. O HEAD atual contém alterações posteriores de código e CI; este registro não
afirma que elas foram revisadas nem validadas.

## 2. Como foi verificado

| Verificação                     | Comando                                                              | Resultado                                                                                                                                                                                                                  |
| :------------------------------ | :------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate de validação               | `bun run check:all`                                                  | Registros antigos reportaram 937 e depois 516 aprovações, mas sem SHA ou ambiente. O arquivo atual os marca como inválidos; são evidências históricas e não comprovam este HEAD.                                           |
| Verificação estática e unitária | `bun run check:fast`                                                 | Registro histórico: 512 testes unitários, `tsc --noEmit`, `oxlint` e `prettier --check` foram reportados como aprovados. Sem SHA e ambiente associados, não comprova o HEAD atual.                                         |
| Carga e capacidade              | `bun run test:load`                                                  | Campanha de nuvem em [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md); linha de base local em [LOAD_TEST_BASELINE.md](LOAD_TEST_BASELINE.md), com 13 cenários. Os resultados são medições anteriores, não execução deste HEAD. |
| Demonstração financeira         | `bun run demo:finance`                                               | ExitCode 0 contra a pilha de contêineres: validação de BET, WIN, REFUND, ROLLBACK, replay e reconciliação.                                                                                                                 |
| Contrato da API HTTP            | `bun test test/unit/openapi/` e `test/e2e/openapi-responses.test.ts` | Rotas, esquemas e respostas reais validados contra `docs/openapi.json`.                                                                                                                                                    |
| Vitrine estática                | `bun test test/unit/site/static-showcase.test.ts`                    | Geração estática validada, publicada e com resposta HTTP 200 via GitHub Pages.                                                                                                                                             |

## 3. Estado de cada item da barra (docs/CHALLENGE.md §14)

Estimativas citadas da barra de avaliação interna (meta estimada de 90/100 pontos).

### 3.1 Correção financeira

- **Pontos da barra:** 20 pontos no enunciado (§14). Meta estimada na revisão simulada: 19 pontos.
- **Evidência:** `src/shared/domain/money.ts` e `test/unit/shared/domain/money.test.ts` (tipo `Money` com precisão decimal exata, sem uso de `number`); `src/shared/infrastructure/database/migrations/Migration20261101000012.ts` (gatilhos `wallets_ledger_balance_check` e `wallet_ledger_entries_balance_check` que recusam no `COMMIT` qualquer divergência entre saldo e ledger); `test/integration/persistence/wallet-persistence.test.ts` e `test/integration/schema/schema-constraints.test.ts` (ledger append-only, recusa `UPDATE`, `DELETE` e `TRUNCATE`); `test/e2e/queries-http.test.ts` (reconciliação entre saldo da carteira e soma dos lançamentos do ledger); `test/concurrency/hot-wallet.test.ts` e `test/unit/wagering/domain/wager-lifecycle.test.ts` (uma reversão por referência, sem crédito duplicado).
- **Lacuna conhecida:** Decisões D1 e D2 abertas. Pela especificação (§6.3), WIN e LOSS podem omitir a referência à BET, impedindo vincular a aposta ou barrar novo resultado. O ROLLBACK de uma BET devolve a aposta mantendo o ganho creditado por um WIN prévio. Ausência de testes baseados em propriedades com `fast-check`.

### 3.2 Concorrência

- **Pontos da barra:** 20 pontos no enunciado (§14). Meta estimada na revisão simulada: 19 pontos.
- **Evidência:** `test/concurrency/hot-wallet.test.ts` (50 requisições simultâneas na mesma carteira sob lock pessimista `SELECT FOR UPDATE`, saldo final exato sem saldo negativo); `test/concurrency/three-processes.test.ts` (50 requisições simultâneas distribuídas em 3 processos aplicam o débito uma única vez); `test/concurrency/distributed-contention.test.ts` (dois workers concorrentes com `SIGKILL` em um deles); `test/integration/persistence/wallet-persistence.test.ts` (recusa de escrita quando a versão esperada está desatualizada).
- **Lacuna conhecida naquele commit:** O mutante M3 sobreviveu em `test/concurrency/distributed-contention.test.ts` (a cláusula `SKIP LOCKED` no outbox é equivalente quanto à integridade funcional, mas nenhum teste afere tempos de espera de lock). Naquele snapshot, a queda da API HTTP durante transação também não tinha cobertura em nível de processo. Depois, `test/concurrency/process-crash-and-shutdown.test.ts` passou a provar `SIGKILL` antes do commit e recuperação por repetição; a queda após commit e antes da resposta HTTP continua sem injeção em nível de processo.

### 3.3 Idempotência

- **Pontos da barra:** 15 pontos no enunciado (§14). Meta estimada na revisão simulada: 14 pontos.
- **Evidência:** Restrição única `UNIQUE (provider_id, idempotency_key)` no banco de dados; `test/integration/wagering/process-wager-transaction.test.ts` (requisição repetida retorna replay do resultado original e saldo observado); `test/integration/messaging/http-and-queue-replay.test.ts` (mesmo comando recebido por HTTP e por SQS, em ambas as ordens, aplica apenas uma vez); `test/integration/messaging/inbox-message-identity.test.ts` (`wagerMessageFingerprint` recusa carga divergente com `MESSAGE_PAYLOAD_CONFLICT`).
- **Lacuna conhecida:** Mensagens legadas persistidas antes da introdução da impressão digital mantêm apenas o hash de negócio, permitindo reutilização da mesma mensagem com chave de idempotência alterada (janela restrita aos registros legados, F-02).

### 3.4 Mensageria e falhas

- **Pontos da barra:** 15 pontos no enunciado (§14). Meta estimada na revisão simulada: 14 pontos.
- **Evidência:** Gravação transacional da outbox na mesma transação financeira (`test/integration/messaging/wager-command-consumer.test.ts`); lease e reagendamento do outbox decididos por `now()` do banco (`test/integration/messaging/outbox-lease-clock.test.ts` e `test/integration/messaging/outbox-retry-clock.test.ts`); validação estrutural do envelope na tabela do outbox (`test/integration/messaging/outbox-malformed-row.test.ts`, F-01); renovação de visibilidade durante lotes e mensagens demoradas (`test/integration/messaging/visibility-during-batch.test.ts` e `test/integration/messaging/slow-message-hold.test.ts`, F-04 e F-14); recuperação de crash e desligamento com `SIGTERM` (`test/concurrency/process-crash-and-shutdown.test.ts` e `test/concurrency/three-processes.test.ts`); classificação de erros transitórios versus permanentes para DLQ em `test/unit/wagering/domain/events-and-classification.test.ts`.
- **Lacuna conhecida:** A renovação periódica de visibilidade possui teto de 300 s (`holdLimitSeconds`). Comandos mais lentos que esse limite podem ser reentregues a outro consumidor em duplicidade (o efeito financeiro permanece protegido pela idempotência). O custo computacional de chamadas extras ao SQS não foi medido.

### 3.5 Modelagem e arquitetura

- **Pontos da barra:** 10 pontos no enunciado (§14). Meta estimada na revisão simulada: 9 pontos.
- **Evidência:** Mapeamento de fluxos em `ARCHITECTURE.md` §1; portas desacopladas em `src/wagering/application/ports/` e `src/shared/application/ports/`; separação em `messaging/application/inbound/` e `messaging/application/outbound/`; invariantes financeiras encapsuladas nas entidades e em `src/wagering/domain/transaction-settlement.ts`; teste de fronteiras em `test/unit/architecture/domain-boundaries.test.ts` (domínio sem dependências de frameworks ou SDKs).
- **Lacuna conhecida:** Alterações contratuais F-03 (retorno de 404 para transação de outro provedor) e F-13 (persistência de `FAILED` e emissão de `WagerTransactionFailed`) são decisões em aberto, de responsabilidade do dono do desafio.

### 3.6 Testes

- **Pontos da barra:** 10 pontos no enunciado (§14). Meta estimada na revisão simulada: 9 pontos.
- **Evidência histórica:** versões antigas do registro reportaram 937 e depois 516 aprovações, incluindo 73 cenários Gherkin e 365 passos, mas sem SHA ou ambiente. O arquivo atual marca o registro sem proveniência como inválido; não o use como prova do HEAD. A cobertura de ROLLBACK retido antes da BET existe em `test/integration/wagering/pending-reference.test.ts` (`a held ROLLBACK is applied once its BET has been processed, and balances the ledger`).
- **Lacuna conhecida:** Dois cenários com tag `@bloqueado` em `test/features/mensageria.feature` não rodam no gate de features; 22 IDs da matriz `docs/audit/EDGE_CASE_MATRIX.md` não possuem a tag `@edge:` nos arquivos de feature; sem testes contínuos de mutação no CI.

### 3.7 Observabilidade

- **Pontos da barra:** 5 pontos no enunciado (§14). Meta estimada na revisão simulada: 5 pontos.
- **Evidência:** Logs estruturados em JSON sem dados confidenciais de payload ou valores monetários (`src/shared/observability/structured-log.ts`); rota `/metrics` no formato do Prometheus (`src/metrics/metrics.controller.ts`) com as métricas exigidas pela §12: `transactions_total`, `idempotent_replays_total`, `commands_total`, `retries_total`, `concurrency_conflicts_total`, `wallet_lock_wait_ms`, `outbox_lag_seconds` e `processing_latency_ms`; testes em `test/e2e/metrics-prometheus.test.ts` e `test/unit/metrics/metrics-collector.test.ts`; probes independentes `/health/liveness` e `/health/readiness` (`test/e2e/readiness.test.ts`).
- **Lacuna conhecida:** As métricas são expostas por processo sem agregação externa. Prometheus e Grafana não foram incluídos no Compose por decisão de escopo.

### 3.8 Documentação

- **Pontos da barra:** 5 pontos no enunciado (§14). Meta estimada na revisão simulada: 5 pontos.
- **Evidência:** `README.md` com instruções de execução, decisões, comandos e mapa do repositório; par em inglês `README.en.md`; `ARCHITECTURE.md` e `ARCHITECTURE.en.md` descrevendo arquitetura, concorrência, idempotência e limitações; catálogo consolidado em `DECISIONS.md` e `DECISIONS.en.md`; registros de decisão em `docs/adr/`; convenções em `docs/CONVENCOES_DOCUMENTACAO.md`; contrato OpenAPI servido em `/openapi.json` e documentação Swagger UI em `/docs`.
- **Lacuna conhecida:** O documento [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md) é gerado exclusivamente em inglês pelo script `test/load/report.ts`.

## 4. Achados

Fonte: [FINDINGS.md](audit/FINDINGS.md). Total de 15 achados avaliados: 11 fechados no código e 4 abertos.

### 4.1 Achados fechados no código (11)

| ID   | Descrição                                                             | Status no código | Evidência de fechamento                                                                                                                                                                                        |
| :--- | :-------------------------------------------------------------------- | :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | Envelope malformado no outbox interrompia publicação do lote          | Fechado          | Commit `2905535` (migração 9 com restrição `CHECK outbox_envelope_shape`). Teste: `test/integration/messaging/outbox-malformed-row.test.ts`.                                                                   |
| F-02 | Mesmo `messageId` com `idempotencyKey` distinta aceito como duplicata | Fechado          | Commit `2ec4d5e` (inclusão da chave na impressão digital `wagerMessageFingerprint`). Teste: `test/integration/messaging/inbox-message-identity.test.ts`.                                                       |
| F-03 | Resposta 403 para transação de outro provedor revelava sua existência | Fechado          | Commit `154b52a` (resposta 404 uniforme). Teste: `test/e2e/authorization-adversarial.test.ts`. Confirmação de contrato em aberto, de responsabilidade do dono do desafio.                                      |
| F-04 | Lote lento deixava mensagens em voo visíveis para outro consumidor    | Fechado          | Commit `b398e22` (chamada `ChangeMessageVisibilityBatch` antes de cada mensagem). Teste: `test/integration/messaging/visibility-during-batch.test.ts`.                                                         |
| F-05 | Ganchos de falha de teste dentro do código de produção                | Fechado          | Commit `489df8b` (extração para `assembleWorker` e seams em `test/support/worker-seams.ts`). Suítes passam sem alteração de asserções.                                                                         |
| F-06 | Concordância entre saldo e ledger não era garantida pelo esquema      | Fechado          | Migração 12 no commit `c5ddca9` (gatilhos `wallets_ledger_balance_check` e `wallet_ledger_entries_balance_check`). Teste: `test/integration/schema/ledger-agreement-trigger.test.ts`.                          |
| F-07 | Lease do outbox comparava expiração com relógio local do chamador     | Fechado          | Commits `433ebe2` e `c952ba2` (posse e reagendamento via `now()` do banco). Testes: `test/integration/messaging/outbox-lease-clock.test.ts` e `test/integration/messaging/outbox-retry-clock.test.ts`.         |
| F-08 | Resumo do ledger na reconciliação era lido fora da transação          | Fechado          | Commit `0f4fa19` (leitura via `em.execute` dentro da transação sob lock). Teste: `test/integration/schema/wallet-ledger-summary.test.ts`.                                                                      |
| F-13 | Transação com falha permanente travava worker; `FAILED` sem caminho   | Fechado          | Commit `c8ffbcc` (registro de `FAILED` e evento `WagerTransactionFailed`). Teste: `test/integration/wagering/held-failure.test.ts`. Confirmação de contrato em aberto, de responsabilidade do dono do desafio. |
| F-14 | Mensagem com tempo maior que a janela de visibilidade era reentregue  | Fechado          | Commit `6b3b23e` (renovação a cada terço da janela até o limite de 300 s). Testes: `test/integration/messaging/slow-message-hold.test.ts` e `test/unit/messaging/application/wager-command-hold.test.ts`.      |
| F-15 | Worker decidia prazo de referência pelo próprio relógio               | Fechado          | Commit `fc3862c` (`DatabaseClock` lendo `now()` do banco na transação). Teste: `test/integration/wagering/database-clock-references.test.ts`.                                                                  |

A confirmação do fechamento de F-06 consta no histórico do arquivo da migração 12 (`git log --oneline -- src/shared/infrastructure/database/migrations/Migration20261101000012.ts`): commit `c5ddca9`.

### 4.2 Achados abertos (4)

| ID   | Descrição                                                          | Status | Detalhes                                                                                                                                                                                                          |
| :--- | :----------------------------------------------------------------- | :----- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-09 | Plano de consulta do ledger depende das estatísticas do PostgreSQL | Aberto | Requer monitoramento com `EXPLAIN` em produção. Testes medidos: varredura em 1.000 lançamentos (0,68 ms), índice em 100.000 (0,44 ms) e 1.000.000 (0,50 ms).                                                      |
| F-10 | `ROLLBACK` do BET após `ROLLBACK` do REFUND é recusado             | Aberto | Decisão de contrato (D4) em aberto, de responsabilidade do dono do desafio. O código aplica a recusa com `REFERENCE_ALREADY_REVERSED`, fixada em teste.                                                           |
| F-11 | Resultados sem referência não podem ser limitados a um por BET     | Aberto | Decisão de contrato (D1) decorrente da especificação (§6.3, §7). Documentado em `ARCHITECTURE.md` §13 e `docs/INVARIANT_REVIEW.md`.                                                                               |
| F-12 | A imagem Docker do repositório não constrói no ambiente de sandbox | Aberto | O proxy TLS do sandbox emite certificado autoassinado (`SELF_SIGNED_CERT_IN_CHAIN`) no `bun install`. Contornado no sandbox por imagem externa de teste; o build foi verificado com sucesso no CI GitHub Actions. |

## 5. Decisões registradas como abertas naquele snapshot

Este bloco descreve o estado histórico da revisão de `bffe108` e não o estado atual. Naquele momento, oito questões eram registradas como aguardando confirmação; D1–D4 foram confirmadas em 2026-11-01, conforme a atualização posterior. As demais perguntas de contrato são dúvidas para o responsável pelo enunciado, não aprovação interna pendente.

- **F-03 (Status HTTP para transação de outro provedor):** Na rota `GET /wagering/transactions/:id`, transação de outro provedor responde `404 TRANSACTION_NOT_FOUND`, idêntico ao identificador inexistente, para evitar a sondagem de transações alheias. Decisão em aberto, de responsabilidade do dono do desafio: confirmar o status 404 uniforme ou reverter para 403.
- **F-10 (ROLLBACK de BET após ROLLBACK de REFUND):** Quando um REFUND é desfeito por ROLLBACK, o posterior ROLLBACK da BET é recusado com `REFERENCE_ALREADY_REVERSED`. Decisão em aberto, de responsabilidade do dono do desafio: confirmar se uma referência admite no máximo uma reversão no total (evitando duplo retorno da aposta) ou se deve admitir reversões líquidas.
- **F-13 (Caminho de execução para FAILED e novo evento):** Uma transação retida com erro irrecuperável é registrada como `FAILED` e anuncia o evento `WagerTransactionFailed` (evento não listado no enunciado §6.3). Decisão em aberto, de responsabilidade do dono do desafio: confirmar a persistência do status `FAILED` e a introdução desse evento.
- **D1 (Resultados sem referência):** O enunciado (§6.3 e §7) permite que WIN e LOSS omitam a referência à aposta. Sem referência, o sistema não pode associar o resultado à BET nem barrar um REFUND posterior ou segundo resultado. Decisão em aberto, de responsabilidade do dono do desafio: aceitar o risco de duplicidade de resultado não vinculado ou exigir a referência à BET em todo resultado.
- **D2 (ROLLBACK em qualquer estado da aposta):** O ROLLBACK é processado em qualquer estado da transação de origem, inclusive após um WIN processado, devolvendo a aposta enquanto o ganho permanece creditado. Decisão em aberto, de responsabilidade do dono do desafio: confirmar se o cancelamento da aposta pode manter o ganho ou se o ROLLBACK da BET com WIN prévio deve ser recusado até a reversão do WIN.
- **D3 (REFUND apenas para BET sem resultado):** Um REFUND é aceito apenas se a aposta não possuir resultado processado (WIN ou LOSS). Havendo resultado, é recusado com `REFERENCE_ALREADY_SETTLED`. Decisão em aberto, de responsabilidade do dono do desafio: confirmar a restrição que obriga o provedor a reverter o resultado antes de pedir estorno.
- **D4 (Uma reversão no máximo por referência):** O sistema restringe qualquer referência a no máximo uma reversão, seja ela REFUND ou ROLLBACK. A regra 4 do enunciado ("não pode ser revertida duas vezes pelo mesmo tipo de operação"), se aplicada literalmente, permitiria um REFUND e depois um ROLLBACK na mesma aposta, creditando o valor duas vezes. Decisão em aberto, de responsabilidade do dono do desafio: confirmar a restrição contra crédito duplicado.
- **D5 (Autenticação por chave de API estática):** Implementação via chaves estáticas com escopo por provedor e papéis (`operator` e `provider`), conforme ADR 0007, em vez de um provedor de identidade externo (IdP) mencionado no enunciado (§2). Decisão em aberto, de responsabilidade do dono do desafio: confirmar a simplificação de autenticação adotada para o escopo do projeto.

## 6. Lacunas que a prova não cobre

Limitações técnicas da suíte de testes e das medições realizadas:

- **§13.7 (referência fora de ordem):** A chegada de REFUND antes da BET é coberta em `test/integration/wagering/pending-reference.test.ts`. A chegada de ROLLBACK antes da BET e sua liquidação após a chegada da aposta também é coberta no mesmo arquivo (`a held ROLLBACK is applied once its BET has been processed, and balances the ledger`). `database-clock-references.test.ts` cobre, separadamente, a retenção e a rejeição após o esgotamento de tentativas.
- **Cenários Gherkin com tag `@bloqueado`:** O comando `grep -c "@bloqueado" test/features/*.feature` registra 2 cenários no arquivo `test/features/mensageria.feature`:
  1. Linha 71: "Uma mensagem que falha em dez entregas vai para a DLQ pelo redrive" (`@edge:QU-04`). Motivo: o harness BDD isolado não recebe a política de redrive do SQS. A cobertura real é provada em `test/integration/messaging/broker-redrive.test.ts`.
  2. Linha 91: "SIGTERM durante um lote conclui o item atual e devolve o restante" (`@edge:QU-07`). Motivo: o harness BDD não controla processos do sistema operacional. A cobertura real é provada em `test/concurrency/process-crash-and-shutdown.test.ts`.
- **Identificadores da matriz de borda sem tag `@edge:`:** A matriz [EDGE_CASE_MATRIX.md](audit/EDGE_CASE_MATRIX.md) define 92 identificadores. Nos arquivos `test/features/*.feature`, 70 identificadores possuem a marcação `@edge:`. Os 22 identificadores sem a tag são: `CF-01`, `CL-01`, `DB-01`, `DB-02`, `DB-03`, `DB-04`, `DB-05`, `EV-01`, `FA-01`, `LC-01`, `LC-02`, `LC-03`, `RS-01`, `RS-02`, `SC-01`, `SC-02`, `SC-03`, `SC-04`, `SC-05`, `SC-06`, `SC-07` e `VW-01`. Cada um desses casos é testado por suítes unitárias, de integração ou de concorrência, mas não foi estruturado em formato Gherkin.
- **Ambientes de medição de carga:** A linha de base da nuvem ([LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md)) foi medida em máquina virtual por um agente. A linha de base local ([LOAD_TEST_BASELINE.md](LOAD_TEST_BASELINE.md)) foi medida em outra máquina física. As medições foram realizadas em ambientes computacionais distintos com hardwares diferentes. Não compare uma medição com a outra.
- **Testes de mutação:** Resultados dos mutantes avaliados contra `test/concurrency/distributed-contention.test.ts` (registrados em [TEST_STRATEGY.md](TEST_STRATEGY.md), seção "Evidência de mutação"):
  - Mutante M1 (remoção do lock pessimista `FOR UPDATE` em `findForUpdate`): Eliminado. O teste sem retentativas falhou com três disputas perdidas.
  - Mutante M2 (remoção da guarda de reversão única em `TransactionSettlement`): Eliminado. Os testes de reembolso com rollbacks e o teste sem retentativas falharam.
  - Mutante M3 (remoção da cláusula `SKIP LOCKED` na busca do outbox): Sobreviveu. O mutante é equivalente em termos de segurança, pois o segundo publicador aguarda o lock e reavalia a condição de lease sem gerar duplicatas. Nenhum teste mede tempos de espera, constituindo lacuna conhecida.
  - Mutante M4 (remoção da verificação de lease expirado no outbox): Eliminado. O teste com dois publicadores falhou com 61 reivindicações duplicadas.

## 7. Revisões simuladas

Histórico das revisões simuladas com notas estimadas internas (não constituem nota da banca avaliadora):

### 7.1 Rodada 1 (Revisão de Invariantes e Auditoria Adversarial)

- **Nota estimada:** 80/100 na revisão de invariantes ([INVARIANT_REVIEW.md](INVARIANT_REVIEW.md)) e 85/100 na auditoria adversarial ([FINDINGS.md](audit/FINDINGS.md)), ambas marcadas como estimativa interna.
- **Achados de maior severidade e correções:**
  - Duplo crédito em apostas com múltiplos WINs ou REFUND após resultado: corrigido com índice único no commit `ce1cb62`.
  - Ausência de validação relacional de moeda e rodada no banco: corrigido com chaves estrangeiras e restrições no commit `f9eb95b`.
  - API sem controle de acesso por provedor: corrigido com autenticação via chaves de API no commit `6ff6891`.
  - F-01 (envelope malformado parando outbox): corrigido pela migração 9 no commit `2905535`.
  - F-02 (falta da chave de idempotência na identidade da mensagem): corrigido pela impressão digital no commit `2ec4d5e`.
  - F-04 (lote lento reexpondo mensagens em voo): corrigido com renovação em lote no commit `b398e22`.
  - F-05 (hooks de teste no código de produção): corrigido pela composição de dependências no commit `489df8b`.
  - F-13 (retenção com falha permanente travando worker): corrigido com transição para `FAILED` no commit `c8ffbcc`.
  - F-14 (mensagem demorada reentregue após janela): corrigido com renovação contínua de visibilidade no commit `6b3b23e`.
  - F-15 e F-07 (prazos e leases usando relógio local do chamador): corrigido com uso de `now()` do banco nos commits `fc3862c` e `433ebe2`.

### 7.2 Rodada 2 (Revisão Simulada e Rodada de Qualidade)

- **Nota estimada:** 90/100, marcada como meta estimada interna.
- **Achados de maior severidade e correções:**
  - F-06 (saldo divergente do ledger aceito em escrita direta no banco): corrigido pela migração 12 com gatilhos de concordância no commit `c5ddca9`.
  - Acoplamento em portas de infraestrutura: corrigido pela segregação de portas em `application/ports/` e separação dos fluxos de entrada e saída no commit `ef390fe`.
  - Métrica `retries_total` ausente (§12): implementada e exposta em `/metrics` no commit `4ee8f72`.
  - Ausência de suíte BDD executável rastreável à matriz de borda: implementada com 73 cenários Gherkin em `test/features/` nos commits `3620d74` e `c8320ea`.

## 8. Automação de segurança

Os workflows de CodeQL, Trivy, Dependency Review e Dependabot estão configurados; a configuração e seus gatilhos
estão descritos em [SECURITY_AUTOMATION.md](SECURITY_AUTOMATION.md). Resultados hospedados do GitHub e execuções
de PR não foram executados nem revisados nesta auditoria.

## 9. Atualização da rodada final (2026-11-02)

As seções 1–8 acima continuam sendo o retrato histórico do commit `bffe108`. O código e os workflows desta rodada
partem de `37ff489`; os commits locais são `e486d38` (smoke SQS no worker real, propriedades de Money e isolamento
do modo protegido) e `b85af0e` (dispatch manual, job protegido e SBOM). Os resultados abaixo são verificações locais
desta rodada, não resultados hospedados nem prova de CI em um SHA publicado.

- **Decisões financeiras:** D1–D4 foram confirmadas em 2026-11-01. O WIN sem referência continua sem associação que
  permita provar unicidade por BET; D2 continua sendo reversão individual, sem cascata. O ROLLBACK retido antes da BET
  é aplicado uma vez após sua chegada em `test/integration/wagering/pending-reference.test.ts`.
- **F-03 e F-13:** os defeitos de implementação estão fechados e têm regressões: 404 uniforme para transação de outro
  provedor (`test/e2e/authorization-adversarial.test.ts`) e caminho terminal `FAILED` com evento para falha permanente
  (`test/integration/wagering/held-failure.test.ts`). A dúvida histórica sobre esses detalhes não listados literalmente
  no enunciado é uma questão de contrato, não um defeito sem correção.
- **Crashes HTTP:** `test/concurrency/process-crash-and-shutdown.test.ts` mata a API antes do commit e depois do commit,
  antes da resposta. O retry após commit retorna replay e mantém um débito, uma linha financeira e um evento.
- **Gate local:** `bun install --frozen-lockfile`, `bun run agent:verify` (538 testes unitários aprovados, 0 falhas),
  `bun run check:all` e `bun run check:financial-invariants` passaram. O Cucumber gerou 73/73 cenários e 438/438
  passos aprovados; dois cenários `@bloqueado` permanecem fora da execução. O verificador SQL retornou zero em INV-1
  a INV-11 e esperava 17 migrations em INV-12.
- **Testcontainers:** `bun run test:containers` passou com 20 testes e 94 assertions. Execuções registradas: 22,17 s de
  startup e 8,32 s de testes em `47617e7`; 24,85 s e 8,77 s, respectivamente, em `2284a9d`. A comparação pontual
  com Compose continua não sendo benchmark.
- **Smoke e proteção:** `demo:finance` e `smoke:sqs-worker` passaram contra a stack Compose já em execução; o segundo
  publicou dois envelopes distintos ao worker real e verificou uma única BET, saldo 99.00 e ledger reconciliado.
  `test/edge/protected-mode.test.ts` passou 12 testes e 85 assertions em um projeto isolado.
- **Pages:** `bun run site:build` passou em `2284a9d` e validou 379 links do repositório; a execução após este ajuste
  de documentação é registrada junto ao SHA final no relatório de release.
- **Limite de imagem:** o Dockerfile versionado permaneceu por mais de dois minutos parado em `bun install` mesmo com
  proxy e CA configurados; o build foi interrompido sem produzir uma imagem. O smoke SQS usou a stack real já
  disponível, portanto não comprova rebuild do Dockerfile desta rodada.
- **GitHub Actions e segurança:** os pushes de `47617e7` e `2284a9d` para `main` foram aceitos, mas as páginas públicas
  de checks de ambos continuaram sem checks. O CI declara `push` e `workflow_dispatch`; a tentativa manual recebeu
  `Forbidden` de `api.github.com`. O
  `GH_TOKEN` era inválido, embora as páginas públicas de `github.com` e o push Git remoto estivessem acessíveis. Não
  foi possível inspecionar o ator/credencial do push nem as configurações da organização, então a causa da ausência de
  workflow não está comprovada. Nenhum resultado hospedado de CI, Dependency Review, CodeQL, Trivy ou SBOM foi observado
  para o SHA atual.

## 10. Verificação de release iniciada no HEAD `44a793bcb09d72620660339186a046311b4e549a`

Esta atualização preserva os históricos acima e registra a última revisão local. A [página pública de checks do HEAD de
entrada](https://github.com/dedeusgui/backend-challenge/commit/44a793bcb09d72620660339186a046311b4e549a/checks) não mostrou
execuções. `gh run list` recebeu `Forbidden` de `api.github.com`; a identidade do push e as configurações de Actions não
puderam ser inspecionadas. Não há evidência para atribuir a ausência a `GITHUB_TOKEN`.

- **Modo protegido:** reproduzido o bypass de limite de escrita em `POST /wallets/` e
  `POST /wagering/transactions/` com barra final. Antes da correção, 42 requests simultâneos por rota receberam zero
  respostas `429`; depois, o Nginx passou a aplicar a cota às duas formas de rota e a suíte real da borda passou com
  14 testes e 87 asserções.
- **Revisão financeira/distribuída:** não foi identificado defeito novo. D1–D4 permaneceram inalteradas; o teste de
  crash HTTP pós-commit e replay já existente continua cobrindo um único débito e evento.
- **Modelo financeiro:** um modelo de referência independente compara sequências limitadas de BET, WIN, LOSS, REFUND e
  ROLLBACK com os casos de uso e PostgreSQL; seed `20261102`, 12 sequências, incluindo replay após cada ação.
- **Gates locais:** `bun install --frozen-lockfile` passou; `bun run agent:verify` passou com 538 testes unitários;
  `bun run check:all` passou com 4 testes de infraestrutura, 261 de integração, 26 de concorrência, 104 e2e, e 73
  cenários/438 passos Cucumber.
- **Testcontainers:** passou com 20 testes e 94 asserções; nesta execução, inicialização 24,03 s e testes 10,40 s.
- **Runtime SQS:** `bun run smoke:sqs-worker` enviou dois envelopes FIFO distintos ao worker Compose real, conferiu
  status, saldo de `99.00` e ledger pelo PostgreSQL/API, e confirmou um único débito após replay.
- **SQL e Pages:** o verificador encontrou zero violações em INV-1 a INV-11 e 17 migrations esperadas em INV-12.
  `site:build` gerou 7 arquivos e validou 380 links no checkout de trabalho.
- **Bloqueio hospedado:** não foram observados checks hospedados para o SHA de entrada. Um mantenedor ainda precisa
  disparar CI e CodeQL para o SHA de release; Dependency Review requer uma pull request para `main`. Até isso ocorrer,
  a release não tem aprovação de CI/segurança associada ao SHA final.

## 11. Estado hospedado depois do push (`440fc2240cac979c28f68c268ecc295255cbf04b`)

O push de `main` foi aceito e `git ls-remote` confirmou esse SHA como ponta remota. A [página pública de checks](https://github.com/dedeusgui/backend-challenge/commit/440fc2240cac979c28f68c268ecc295255cbf04b/checks)
respondeu “There are no checks for this commit”; a [lista de Actions](https://github.com/dedeusgui/backend-challenge/actions)
não mostrou run desse SHA. O `gh` não tem sessão válida (`GH_TOKEN` inválido), e o proxy bloqueou `api.github.com` com
403; esse host não consta na allowlist observada. A causa de não haver workflow continua sem comprovação. Um mantenedor
precisa executar CI e CodeQL no SHA de release pela interface do GitHub e abrir uma PR para obter Dependency Review.
Esta atualização registra evidência posterior ao push de `440fc22`; não afirma checks para o commit que a registra.

## 12. Atualização posterior: evidências e estado atual (2026-11-02)

As seções 1–8 preservam o registro da revisão histórica de `bffe108`. Após aquela revisão, as propriedades de `Money` com `fast-check` entraram em `e486d38`, e o modelo financeiro independente com sequências geradas foi adicionado em `7bb288f`; o limite por rota com barra final foi corrigido em `01ec4a1`; os workflows tiveram ajustes em `b85af0e`, `17edca1` e `a3abbae`. Isso não reescreve os resultados históricos nem afirma validação hospedada desses commits.

- **Decisões técnicas confirmadas:** D1–D4 foram confirmadas em 2026-11-01 e estão catalogadas como R-01, R-04/R-05, R-03 e R-06 em [DECISIONS.md](../DECISIONS.md). São interpretações aplicadas e testadas, não itens aguardando aprovação interna.
- **Interpretação adicional ao enunciado:** D1 mantém opcional a referência de WIN/LOSS, e D4 limita a uma reversão efetiva por referência, embora a regra 4 mencione repetição “pelo mesmo tipo”. Ambas foram confirmadas para esta implementação.
- **Limitação conhecida:** WIN sem referência não pode ser associado a uma BET para demonstrar unicidade por aposta. O ROLLBACK da BET após WIN é individual: devolve a aposta e não desfaz o WIN; cada transação exige sua própria reversão.
- **Questão para a Jungle Gaming:** somente a Jungle Gaming pode esclarecer se pretendia uma semântica diferente para essas ambiguidades ou para perguntas adicionais de contrato (como status HTTP 404 e o evento `WagerTransactionFailed`). Não há decisão interna aguardando essa confirmação.
- **Evidências atuais:** `test/unit/shared/domain/money.property.test.ts`, `test/integration/model/financial-reference-model.test.ts`, `test/integration/model/random-sequences.test.ts`, `test/concurrency/process-crash-and-shutdown.test.ts` e [TEST_STRATEGY.md](TEST_STRATEGY.md). As afirmações locais de validação são as registradas nas atualizações anteriores; este complemento não afirma resultado hospedado para o HEAD atual.
- **Riscos restantes:** não há execução hospedada confirmada para o SHA atual; o build de imagem permanece limitado pelo proxy observado; a associação de WIN sem referência permanece impossível e a renovação de visibilidade do SQS tem teto de 300 s.
