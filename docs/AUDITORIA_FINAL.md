# Auditoria final

> Versão principal em português. A cópia de referência em inglês é [AUDITORIA_FINAL.en.md](AUDITORIA_FINAL.en.md).

Registro final da auditoria da entrega: código auditado, métodos de verificação, estado de cada item da barra de avaliação, situação dos achados, decisões que dependem do dono do desafio, lacunas não cobertas e revisões simuladas.

Os dados brutos de execução não são versionados no repositório.

## 1. Código auditado

- **Commit:** `bffe108`
- **Comando de obtenção:** `git log -1 --format=%h -- src test`
- **Data:** 2026-11-01 (19:21:49 -0300)

Commits posteriores a esse hash alteraram exclusivamente documentação e arquivos de catálogo.

## 2. Como foi verificado

| Verificação                     | Comando                                                              | Resultado                                                                                                                                                                                                                                                                                           |
| :------------------------------ | :------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate de validação               | `bun run check:all`                                                  | Registrado em `docs/gate/ultimo-gate.json` (2026-11-01T20:40:46.191Z, exitCode 0). 937 testes sem falhas: 490 unitários, 4 de infraestrutura, 247 de integração, 23 de concorrência, 100 e2e e 73 cenários Gherkin (365 passos).                                                                    |
| Verificação estática e unitária | `bun run check:fast`                                                 | Sucesso em 512 testes unitários (0 falhas), `tsc --noEmit` sem erros, `oxlint` sem avisos em 256 arquivos e `prettier --check` aprovado.                                                                                                                                                            |
| Carga e capacidade              | `bun run test:load`                                                  | Benchmarks registrados em [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md), e a linha de base local em [LOAD_TEST_BASELINE.md](LOAD_TEST_BASELINE.md) (medição na nuvem em 1, 2 e 4 CPUs com 100, 200 e 400 req/s) e em [LOAD_TEST_BASELINE.md](LOAD_TEST_BASELINE.md) (medição local com 13 cenários). |
| Demonstração financeira         | `bun run demo:finance`                                               | ExitCode 0 contra a pilha de contêineres: validação de BET, WIN, REFUND, ROLLBACK, replay e reconciliação.                                                                                                                                                                                          |
| Contrato da API HTTP            | `bun test test/unit/openapi/` e `test/e2e/openapi-responses.test.ts` | Rotas, esquemas e respostas reais validados contra `docs/openapi.json`.                                                                                                                                                                                                                             |
| Vitrine estática                | `bun test test/unit/site/static-showcase.test.ts`                    | Geração estática validada, publicada e com resposta HTTP 200 via GitHub Pages.                                                                                                                                                                                                                      |

## 3. Estado de cada item da barra (docs/CHALLENGE.md §14)

Estimativas citadas da barra de avaliação interna (meta estimada de 90/100 pontos).

### 3.1 Correção financeira

- **Pontos da barra:** 20 pontos no enunciado (§14). Meta estimada na revisão simulada: 19 pontos.
- **Evidência:** `src/shared/domain/money.ts` e `test/unit/shared/domain/money.test.ts` (tipo `Money` com precisão decimal exata, sem uso de `number`); `src/shared/infrastructure/database/migrations/Migration20261101000012.ts` (gatilhos `wallets_ledger_balance_check` e `wallet_ledger_entries_balance_check` que recusam no `COMMIT` qualquer divergência entre saldo e ledger); `test/integration/persistence/wallet-persistence.test.ts` e `test/integration/schema/schema-constraints.test.ts` (ledger append-only, recusa `UPDATE`, `DELETE` e `TRUNCATE`); `test/e2e/queries-http.test.ts` (reconciliação entre saldo da carteira e soma dos lançamentos do ledger); `test/concurrency/hot-wallet.test.ts` e `test/unit/wagering/domain/wager-lifecycle.test.ts` (uma reversão por referência, sem crédito duplicado).
- **Lacuna conhecida:** Decisões D1 e D2 confirmadas em 2026-11-01. Pela especificação (§6.3), WIN e LOSS podem omitir a referência à BET, impedindo vincular a aposta ou barrar novo resultado. O ROLLBACK de uma BET devolve a aposta mantendo o ganho creditado por um WIN prévio. Ausência de testes baseados em propriedades com `fast-check`.

### 3.2 Concorrência

- **Pontos da barra:** 20 pontos no enunciado (§14). Meta estimada na revisão simulada: 19 pontos.
- **Evidência:** `test/concurrency/hot-wallet.test.ts` (50 requisições simultâneas na mesma carteira sob lock pessimista `SELECT FOR UPDATE`, saldo final exato sem saldo negativo); `test/concurrency/three-processes.test.ts` (50 requisições simultâneas distribuídas em 3 processos aplicam o débito uma única vez); `test/concurrency/distributed-contention.test.ts` (dois workers concorrentes com `SIGKILL` em um deles); `test/integration/persistence/wallet-persistence.test.ts` (recusa de escrita quando a versão esperada está desatualizada).
- **Lacuna conhecida:** O mutante M3 sobreviveu em `test/concurrency/distributed-contention.test.ts` (a cláusula `SKIP LOCKED` no outbox é equivalente quanto à integridade funcional, mas nenhum teste afere tempos de espera de lock). Queda forçada (`SIGKILL`) de processo da API HTTP durante uma transação ativa não é testada em nível de processo de sistema operacional.

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
- **Lacuna conhecida:** Alterações contratuais F-03 (retorno de 404 para transação de outro provedor) e F-13 (persistência de `FAILED` e emissão de `WagerTransactionFailed`) foram confirmadas em 2026-11-01.

### 3.6 Testes

- **Pontos da barra:** 10 pontos no enunciado (§14). Meta estimada na revisão simulada: 9 pontos.
- **Evidência:** 937 testes sem mocks de PostgreSQL ou LocalStack nas suítes de integração, concorrência e e2e (`docs/gate/ultimo-gate.json`); 73 cenários Gherkin executáveis cobrindo 365 passos (`test/features/`); injeção de falhas com encerramento de processos reais via `SIGKILL` e `SIGTERM` (`test/concurrency/three-processes.test.ts` e `test/concurrency/process-crash-and-shutdown.test.ts`).
- **Lacuna conhecida:** Dois cenários com tag `@bloqueado` em `test/features/mensageria.feature` não rodam no gate de features; 22 IDs da matriz `docs/audit/EDGE_CASE_MATRIX.md` não possuem a tag `@edge:` nos arquivos de feature; não há teste cobrindo ROLLBACK antes do BET com aplicação posterior (§13.7); sem testes contínuos de mutação no CI.

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

| ID   | Descrição                                                             | Status no código | Evidência de fechamento                                                                                                                                                                                   |
| :--- | :-------------------------------------------------------------------- | :--------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | Envelope malformado no outbox interrompia publicação do lote          | Fechado          | Commit `2905535` (migração 9 com restrição `CHECK outbox_envelope_shape`). Teste: `test/integration/messaging/outbox-malformed-row.test.ts`.                                                              |
| F-02 | Mesmo `messageId` com `idempotencyKey` distinta aceito como duplicata | Fechado          | Commit `2ec4d5e` (inclusão da chave na impressão digital `wagerMessageFingerprint`). Teste: `test/integration/messaging/inbox-message-identity.test.ts`.                                                  |
| F-03 | Resposta 403 para transação de outro provedor revelava sua existência | Fechado          | Commit `154b52a` (resposta 404 uniforme). Teste: `test/e2e/authorization-adversarial.test.ts`. Contrato confirmado em 2026-11-01.                                                                         |
| F-04 | Lote lento deixava mensagens em voo visíveis para outro consumidor    | Fechado          | Commit `b398e22` (chamada `ChangeMessageVisibilityBatch` antes de cada mensagem). Teste: `test/integration/messaging/visibility-during-batch.test.ts`.                                                    |
| F-05 | Ganchos de falha de teste dentro do código de produção                | Fechado          | Commit `489df8b` (extração para `assembleWorker` e seams em `test/support/worker-seams.ts`). Suítes passam sem alteração de asserções.                                                                    |
| F-06 | Concordância entre saldo e ledger não era garantida pelo esquema      | Fechado          | Migração 12 no commit `c5ddca9` (gatilhos `wallets_ledger_balance_check` e `wallet_ledger_entries_balance_check`). Teste: `test/integration/schema/ledger-agreement-trigger.test.ts`.                     |
| F-07 | Lease do outbox comparava expiração com relógio local do chamador     | Fechado          | Commits `433ebe2` e `c952ba2` (posse e reagendamento via `now()` do banco). Testes: `test/integration/messaging/outbox-lease-clock.test.ts` e `test/integration/messaging/outbox-retry-clock.test.ts`.    |
| F-08 | Resumo do ledger na reconciliação era lido fora da transação          | Fechado          | Commit `0f4fa19` (leitura via `em.execute` dentro da transação sob lock). Teste: `test/integration/schema/wallet-ledger-summary.test.ts`.                                                                 |
| F-13 | Transação com falha permanente travava worker; `FAILED` sem caminho   | Fechado          | Commit `c8ffbcc` (registro de `FAILED` e evento `WagerTransactionFailed`). Teste: `test/integration/wagering/held-failure.test.ts`. Contrato confirmado em 2026-11-01.                                    |
| F-14 | Mensagem com tempo maior que a janela de visibilidade era reentregue  | Fechado          | Commit `6b3b23e` (renovação a cada terço da janela até o limite de 300 s). Testes: `test/integration/messaging/slow-message-hold.test.ts` e `test/unit/messaging/application/wager-command-hold.test.ts`. |
| F-15 | Worker decidia prazo de referência pelo próprio relógio               | Fechado          | Commit `fc3862c` (`DatabaseClock` lendo `now()` do banco na transação). Teste: `test/integration/wagering/database-clock-references.test.ts`.                                                             |

A confirmação do fechamento de F-06 consta no histórico do arquivo da migração 12 (`git log --oneline -- src/shared/infrastructure/database/migrations/Migration20261101000012.ts`): commit `c5ddca9`.

### 4.2 Achados abertos (4)

| ID   | Descrição                                                          | Status                                       | Detalhes                                                                                                                                                                                                          |
| :--- | :----------------------------------------------------------------- | :------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-09 | Plano de consulta do ledger depende das estatísticas do PostgreSQL | Aberto                                       | Requer monitoramento com `EXPLAIN` em produção. Testes medidos: varredura em 1.000 lançamentos (0,68 ms), índice em 100.000 (0,44 ms) e 1.000.000 (0,50 ms).                                                      |
| F-10 | `ROLLBACK` do BET após `ROLLBACK` do REFUND é recusado             | Fechado por decisão confirmada em 2026-11-01 | Decisão D4 confirmada em 2026-11-01. O código aplica a recusa com `REFERENCE_ALREADY_REVERSED`, fixada em teste.                                                                                                  |
| F-11 | Resultados sem referência não podem ser limitados a um por BET     | Fechado por decisão confirmada em 2026-11-01 | Decisão D1 confirmada em 2026-11-01. Pela especificação (§6.3, §7), WIN sem referência não demonstra unicidade da liquidação por BET. Documentado em `ARCHITECTURE.md` §13 e `docs/INVARIANT_REVIEW.md`.          |
| F-12 | A imagem Docker do repositório não constrói no ambiente de sandbox | Aberto                                       | O proxy TLS do sandbox emite certificado autoassinado (`SELF_SIGNED_CERT_IN_CHAIN`) no `bun install`. Contornado no sandbox por imagem externa de teste; o build foi verificado com sucesso no CI GitHub Actions. |

## 5. Decisões de contrato e seus estados

F-03, F-13 e D1 a D4 foram confirmadas em 2026-11-01; somente D5 permanece aberta. O código implementa as alternativas documentadas.

- **F-03 (Status HTTP para transação de outro provedor):** Na rota `GET /wagering/transactions/:id`, transação de outro provedor responde `404 TRANSACTION_NOT_FOUND`, idêntico ao identificador inexistente, para evitar a sondagem de transações alheias. Confirmado em 2026-11-01: 404 uniforme e mesmo corpo para outro provedor e transação inexistente, para não revelar existência.
- **F-10 (ROLLBACK de BET após ROLLBACK de REFUND):** Quando um REFUND é desfeito por ROLLBACK, o posterior ROLLBACK da BET é recusado com `REFERENCE_ALREADY_REVERSED`. D4 confirmado em 2026-11-01: no máximo uma reversão efetiva por referência, qualquer que seja o tipo. É interpretação adicional, não o texto literal da especificação.
- **F-13 (Caminho de execução para FAILED e novo evento):** Uma transação retida com erro irrecuperável é registrada como `FAILED` e anuncia o evento `WagerTransactionFailed` (evento não listado no enunciado §6.3). Confirmado em 2026-11-01 como extensão: `FAILED` é estado auditável para falhas permanentes e `WagerTransactionFailed` é evento adicional; a especificação exige quatro eventos.
- **D1 (Resultados sem referência):** O enunciado (§6.3 e §7) permite que WIN e LOSS omitam a referência à aposta. Sem referência, o sistema não pode associar o resultado à BET nem barrar um REFUND posterior ou segundo resultado. Confirmado em 2026-11-01: WIN/LOSS podem omitir referência; quando citam BET, validam o contexto completo. Não se infere associação por roundId ou heurística; WIN sem referência não demonstra unicidade por BET.
- **D2 (ROLLBACK em qualquer estado da aposta):** O ROLLBACK é processado em qualquer estado da transação de origem, inclusive após um WIN processado, devolvendo a aposta enquanto o ganho permanece creditado. Confirmado em 2026-11-01: o ROLLBACK da BET reverte apenas essa transação, não cancela WIN já processado. O WIN precisa de seu próprio ROLLBACK para reverter o crédito; não há cascata implícita.
- **D3 (REFUND apenas para BET sem resultado):** Um REFUND é aceito apenas se a aposta não possuir resultado processado (WIN ou LOSS). Havendo resultado, é recusado com `REFERENCE_ALREADY_SETTLED`. Confirmado em 2026-11-01: REFUND somente para BET PROCESSED sem resultado; após WIN, LOSS ou reversão conflitante é recusado. BET não é reaberta quando seu REFUND é desfeito.
- **D4 (Uma reversão no máximo por referência):** O sistema restringe qualquer referência a no máximo uma reversão, seja ela REFUND ou ROLLBACK. A regra 4 do enunciado ("não pode ser revertida duas vezes pelo mesmo tipo de operação"), se aplicada literalmente, permitiria um REFUND e depois um ROLLBACK na mesma aposta, creditando o valor duas vezes. Confirmado em 2026-11-01: no máximo uma reversão efetiva por referência. É interpretação adicional, não o texto literal da especificação.
- **D5 (Autenticação por chave de API estática):** Implementação via chaves estáticas com escopo por provedor e papéis (`operator` e `provider`), conforme ADR 0007, em vez de um provedor de identidade externo (IdP) mencionado no enunciado (§2). D5 continua aberta; esta instrução não decide a autenticação por chave estática.

## 6. Lacunas que a prova não cobre

Limitações técnicas da suíte de testes e das medições realizadas:

- **§13.7 (ROLLBACK antes da referência):** Para a chegada de REFUND antes do BET, existe teste automatizado em `test/integration/wagering/pending-reference.test.ts`. Para a chegada de ROLLBACK antes do BET com posterior liquidação bem-sucedida após a chegada da aposta, não existe teste no repositório. O teste existente em `test/integration/wagering/database-clock-references.test.ts` (linhas 158 a 191) cobre apenas a retenção e a rejeição após o esgotamento de tentativas.
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
