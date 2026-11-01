# Comparação com implementações públicas de referência

Este documento registra a análise comparativa entre este projeto e implementações públicas do mesmo desafio, com base na leitura estática de código-fonte e na extração sistemática de práticas. O texto documenta os critérios de triagem, as práticas identificadas, as soluções adotadas com os respectivos commits comprobatórios, as abordagens rejeitadas e as limitações de verificação.

## 1. O que foi comparado

Os arquivos brutos da triagem, das notas e dos clusters ficaram fora do repositório e não são versionados. Os números abaixo são os que esses arquivos registram.

A identificação de referências partiu de 165 repositórios candidatos levantados via API do GitHub (registro em dados brutos não versionados). Todos os candidatos passaram por triagem automatizada da árvore de arquivos no branch padrão (dados brutos não versionados), contabilizando a presença de sinais específicos de implementação:

- **Sinais de outbox ou inbox:** 133 repositórios continham ocorrências no caminho de arquivos (coluna 4 de dados brutos não versionados).
- **Sinais de mensageria SQS ou FIFO:** 138 repositórios continham ocorrências (coluna 6 de dados brutos não versionados).
- **Especificações Gherkin (`.feature`):** 0 repositórios apresentavam arquivos com essa extensão (coluna 5 de dados brutos não versionados).
- **Árvores válidas inspecionadas:** 165 repositórios responderam com estrutura legível (coluna 3 de dados brutos não versionados).

A partir da triagem inicial, 128 notas detalhadas de repositórios foram produzidas por leitura estática em clones locais somente leitura (contagem de arquivos em dados brutos não versionados). A verificação de ramos secundários avaliou 124 notas (dados brutos não versionados), identificando 22 repositórios com branches adicionais e 10 branches com commits à frente do branch padrão (contagem de dados brutos não versionados, totalizando 129 entradas de branches). Quatro branches com histórico divergente relevante tiveram notas complementares elaboradas (contagem de arquivos em dados brutos não versionados).

A triagem de conteúdo em dados brutos não versionados avaliou 121 repositórios com clone local: 115 foram mantidos para extração de práticas (107 no nível A por possuírem testes de infraestrutura e migrações SQL, 5 no nível B por contarem com ao menos 5 arquivos de teste e 3 no nível C com código estruturado) e 6 foram classificados como sem implementação aproveitável por ausência de código de domínio ou por se limitarem a modelos vazios. A extração sistemática catalogou 28 agrupamentos temáticos de práticas em dados brutos não versionados.

## 2. Práticas encontradas nas implementações lidas

As práticas mapeadas nos repositórios lidos foram agrupadas conforme as áreas de avaliação do desafio:

### Correção financeira

- **Representação decimal exata:** 113 repositórios utilizam bibliotecas decimais de precisão arbitrária ou mapeamentos numéricos sem perda de precisão (cluster `money_decimal_exact` em dados brutos não versionados). Outros forks adotam inteiros em unidades fracionárias (`bigint`) convertendo cadeias de caracteres.
- **Triggers de integridade financeira no commit:** 27 repositórios empregam triggers adiados (`CONSTRAINT TRIGGER DEFERRABLE`) no banco relacional para assegurar a concordância estrita entre o saldo da carteira e o histórico de lançamentos do ledger no momento do commit (cluster `deferred_balance_ledger_trigger` em dados brutos não versionados).
- **Rotinas de reconciliação de saldo:** 43 repositórios mantêm consultas ou views de reconciliação para auditoria periódica de saldos contra a soma de lançamentos (cluster `reconciliation` em dados brutos não versionados).
- **Encadeamento criptográfico no ledger:** 3 repositórios registram hashes encadeados linha a linha para detectar adulterações no histórico contábil (cluster `ledger_hash_chain` em dados brutos não versionados).
- **Diário contábil em partidas dobradas:** 7 repositórios introduzem plano de contas formal com contas de contrapartida da casa (cluster `double_entry_journal` em dados brutos não versionados).

### Concorrência

- **Bloqueio pessimista por carteira:** Uso predominante de `SELECT ... FOR UPDATE` no registro da carteira para serializar transações financeiras disputadas.
- **Limites de espera por bloqueio e instrução:** 37 repositórios configuram limites de tempo de lock (`lock_timeout`) e de execução (`statement_timeout`) por transação para evitar bloqueios indeterminados sob alta disputa (cluster `lock_timeout_statement_timeout` em dados brutos não versionados).
- **Coordenação de tarefas concorrentes:** 120 repositórios utilizam cláusulas `FOR UPDATE SKIP LOCKED` combinadas com tempo de locação (lease) e token de cercamento (fencing token) para reivindicação distribuída de mensagens ou eventos (cluster `skip_locked_lease_fencing` em dados brutos não versionados).

### Idempotência

- **Gravação de inbox e efeito colateral atômicos:** 79 repositórios persistem o registro de inbox na mesma transação de banco de dados que altera o estado financeiro (cluster `inbox_before_or_same_tx` em dados brutos não versionados).
- **Detecção de divergência de carga sob mesma chave:** 85 repositórios armazenam o hash da carga útil para rejeitar requisições que reutilizam chaves de idempotência com parâmetros conflitantes (cluster `payload_hash_conflict` em dados brutos não versionados).
- **Confirmação de mensagem estritamente após o commit:** 47 repositórios postergam a confirmação de leitura (ACK) no broker para momento posterior à efetivação da transação no banco (cluster `ack_after_commit` em dados brutos não versionados).

### Mensageria e falhas

- **Teto de tentativas e quarentena de outbox:** 67 repositórios implementam controle de tentativas de publicação da outbox com estado terminal para isolar eventos irrecuperáveis sem descarte de registros (cluster `outbox_attempt_cap_quarantine` em dados brutos não versionados). Em contrapartida, cerca de 20 notas apontam falha por retentativa infinita sem limite.
- **Retenção e limpeza de eventos publicados:** 44 repositórios estabelecem rotinas de purga de eventos da outbox após decorrido o período de retenção (cluster `outbox_retention_cleanup` em dados brutos não versionados).
- **Devolução de visibilidade no encerramento do processo:** 83 repositórios efetuam liberação imediata de visibilidade (`changeMessageVisibility(0)`) das mensagens retidas em buffer ao receber sinais de terminação do sistema operacional (cluster `shutdown_return_visibility` em dados brutos não versionados).
- **Envio para DLQ antes da remoção da mensagem original:** 80 repositórios garantem que a mensagem com falha terminal seja enviada com sucesso à fila de mensagens mortas antes de sua exclusão da fila principal (cluster `dlq_send_before_delete_risk` em dados brutos não versionados).
- **Reprocessamento com controle de dependência externa:** 57 repositórios contam com fluxo específico para reprocessar transações que aguardam referências externas não resolvidas (cluster `pending_reference_retry` em dados brutos não versionados).
- **Prazos explícitos para chamadas de transporte:** 108 repositórios aplicam limites estritos de tempo para operações de rede com o cliente SQS (cluster `sqs_request_timeout` em dados brutos não versionados).
- **Mecanismos de disjuntor (circuit breaker):** 4 repositórios empregam disjuntores de circuito no transporte de mensageria (cluster `circuit_breaker` em dados brutos não versionados).

### Modelagem e arquitetura

- **Domínio puro e isolado:** Separação estrita de entidades de domínio sem acoplamento a frameworks web ou ORMs.
- **Segregação de privilégios no banco de dados:** 14 repositórios estabelecem papéis relacionais com permissões restritas (runtime sem privilégios de `UPDATE`, `DELETE` ou `TRUNCATE` no ledger) separadas do usuário de migrações (cluster `least_privilege_db_roles` em dados brutos não versionados).
- **Autenticação externa integrada:** 7 repositórios introduzem integração com servidores de identidade, autenticação OIDC ou tokens JWT (cluster `keycloak_oidc_jwt` em dados brutos não versionados).

### Testes

- **Testes com múltiplos processos concorrentes:** 70 repositórios exercitam o comportamento do sistema utilizando múltiplos processos de sistema operacional simultâneos disputando a mesma base de dados (cluster `multi_process_tests` em dados brutos não versionados).
- **Simulação de interrupção forçada entre commit e confirmação:** 100 repositórios testam resiliência a encerramentos abruptos (`SIGKILL` ou falhas forçadas) no intervalo entre a efetivação relacional e o ACK da mensagem (cluster `sigkill_or_crash_between_commit_ack` em dados brutos não versionados).
- **Testes de carga com ferramentas externas:** 9 repositórios utilizam ferramentas como k6 ou Gatling para medição de saturação (cluster `load_test_k6_gatling` em dados brutos não versionados).

### Observabilidade

- **Exposição de métricas no padrão Prometheus:** 117 repositórios contam com endpoint de métricas operacionais para coleta pelo Prometheus (cluster `prometheus_metrics` em dados brutos não versionados).
- **Indicadores de profundidade de filas e outbox:** 70 repositórios expõem medidores de acúmulo da outbox e de mensagens em fila morta (cluster `dlq_or_backlog_gauge` em dados brutos não versionados).
- **Identificador de correlação em logs estruturados:** 7 repositórios propagam identificadores de correlação em saídas estruturadas em formato JSON (cluster `correlation_id` em dados brutos não versionados).
- **Prazo limite em sondas de prontidão:** 107 repositórios aplicam cancelamento por timeout em probes de saúde (cluster `readiness_deadline_abort` em dados brutos não versionados).
- **Validação de migrações em sondas:** 4 repositórios validam o status das migrações do banco no endpoint de readiness (cluster `health_migrations_applied` em dados brutos não versionados).

### Documentação

- Roteiros passo a passo de reprodução via orquestração de contêineres e documentação das decisões de projeto por meio de ADRs.

## 3. O que foi adotado neste projeto

Com base nas práticas identificadas nas referências, as seguintes soluções foram implementadas e verificadas no repositório:

1. **Triggers diferidos de concordância entre saldo e lançamentos:**
   - **Commit:** `c5ddca9` (`feat(ledger): impedir commit com saldo divergente do ledger`).
   - **Implementação:** Criação das funções e gatilhos de restrição `wallets_ledger_balance_check` e `wallet_ledger_entries_balance_check` em `src/shared/infrastructure/database/migrations/Migration20261101000012.ts`. O gatilho adia a checagem até o `COMMIT` e aborta transações que apresentem divergência entre o saldo da carteira e o último lançamento do ledger.
   - **Comprovação:** `test/integration/schema/ledger-balance-trigger.test.ts`.

2. **Limites de espera por bloqueio de carteira e execução transacional:**
   - **Commit:** `4c58edb` (`fix(wagering): limitar a espera por trava de carteira`).
   - **Implementação:** Configuração de `lock_timeout` (5 s) e `statement_timeout` (15 s) via `SET LOCAL` em `src/shared/infrastructure/database/mikro-orm-financial-unit-of-work.ts`. Mapeamento do código de erro PostgreSQL `55P03` como falha transitória com suporte à reentrega controlada.
   - **Comprovação:** `test/integration/wagering/lock-timeout.test.ts`.

3. **Quarentena de eventos da outbox e rotina de reprocessamento:**
   - **Commit:** `216eb8f` (`feat(messaging): quarentena de eventos da outbox após N tentativas`).
   - **Implementação:** Limite configurável de tentativas de publicação na outbox com transição para o estado `QUARANTINED` em `src/modules/messaging/domain/outbox-message.ts` e `src/modules/messaging/infrastructure/mikro-orm-outbox.store.ts`, complementado pelo utilitário administrativo `scripts/outbox-requeue.ts`.
   - **Comprovação:** `test/integration/messaging/outbox-quarantine.test.ts`.

4. **Limpeza programada de eventos da outbox após período de retenção:**
   - **Commit:** `e7af1dd` (`feat(messaging): limpar eventos publicados após a retenção`).
   - **Implementação:** Método `deletePublishedBefore` no repositório outbox invocado ciclicamente pelo worker (`src/worker/run-worker.ts`), apoiado por índice condicional em `src/shared/infrastructure/database/migrations/Migration20261101000015.ts`.
   - **Comprovação:** `test/integration/messaging/outbox-retention.test.ts`.

5. **Devolução imediata de visibilidade no desligamento do consumidor:**
   - **Commit:** `98c39ac` (`fix(messaging): devolver mensagens não processadas ao encerrar`).
   - **Implementação:** Interrupção do ciclo de renovação e devolução explícita de visibilidade (`changeMessageVisibility(0)`) no encerramento ordenado em `src/modules/messaging/application/inbound/wager-command-consumer.ts`.
   - **Comprovação:** `test/integration/messaging/consumer-shutdown.test.ts`.

6. **Prazos delimitados de transporte e aborto de probes de saúde:**
   - **Commit:** `8b3560a` (`fix(infra): prazos reais para chamadas SQS e readiness`).
   - **Implementação:** Parâmetro `requestTimeout` estrito nas conexões SQS (`src/shared/infrastructure/sqs/sqs-connection.ts`) e prazo máximo via `AbortSignal.timeout` nas checagens de prontidão em `src/health/health.service.ts`.
   - **Comprovação:** `test/integration/faults/sqs-deadlines.test.ts` e `test/e2e/health.test.ts`.

7. **Contador consolidado de retentativas operacionais:**
   - **Commit:** `4ee8f72` (`feat(observability): contador retries_total exigido pela §12`).
   - **Implementação:** Exposição da métrica `retries_total` com identificador do subsistema de origem em `src/shared/infrastructure/observability/prometheus-metrics.ts`.
   - **Comprovação:** `test/unit/docs/catalogos.test.ts`.

8. **Suíte executável de especificações Gherkin sob Bun:**
   - **Commit:** `3620d74` (`test(features): executar Gherkin sob Bun com cucumber-js`).
   - **Implementação:** 73 cenários BDD distribuídos em arquivos de especificação em `test/features/`, executados contra PostgreSQL sem utilização de dublês de teste.
   - **Comprovação:** Execução de `bun run test:features`.

## 4. O que foi rejeitado, e o motivo

1. **Publicação síncrona no broker durante a transação de banco de dados:**
   - _Padrão identificado:_ Observado em aproximadamente 15 implementações lidas. A chamada à API do broker de mensageria é executada mantendo a conexão do banco aberta e as linhas da carteira sob bloqueio pessimista.
   - _Motivo da rejeição:_ Conecta a seção crítica relacional à latência de rede e à disponibilidade de um serviço externo. Sob contenção de concorrência ou oscilações de rede, provoca retenção prolongada de conexões e risco de exaustão do pool de banco de dados. O projeto mantém o envio desacoplado por meio da outbox transactional gravada na mesma unidade atômica.

2. **Retentativa de outbox indeterminada sem quarentena:**
   - _Padrão identificado:_ Observado em aproximadamente 20 implementações. Falhas de envio acionam backoff contínuo sem teto de ciclo ou estado terminal.
   - _Motivo da rejeição:_ Mensagens que falham por incompatibilidade de esquema ou dados inválidos geram consumo permanente de ciclos de CPU e IO, degradando a vazão do publicador e mascarando a presença de registros com falha estrutural.

3. **Uso de inteiros em formato `bigint` para representação monetária no domínio:**
   - _Padrão identificado:_ Presente em múltiplos repositórios que operam valores em centavos através de números inteiros, convertendo strings com rotinas de substituição textual.
   - _Motivo da rejeição:_ A manipulação de strings para conversão de escala apresenta fragilidade operacional. O objeto de valor baseado em `decimal.js` assegura precisão arbitrária exata no domínio, validação rigorosa de escala de 2 dígitos decimais e alinhamento direto com o tipo `NUMERIC(20,2)` no PostgreSQL. Detalhado em [docs/adr/0002-money-representation.md](adr/0002-money-representation.md).

4. **Padrão disjuntor de circuito (circuit breaker) no transporte:**
   - _Padrão identificado:_ Presente em 4 repositórios (cluster `circuit_breaker` em dados brutos não versionados).
   - _Motivo da rejeição:_ Adiciona estado volátil ou distribuído sem conferir benefício funcional frente ao modelo do desafio. O controle de retentativas com backoff exponencial truncado, jitter e filas de mensagens mortas fornece o desacoplamento necessário de modo determinístico.

5. **Infraestrutura de autenticação via Keycloak, OIDC ou tokens JWT:**
   - _Padrão identificado:_ Presente em 7 repositórios (cluster `keycloak_oidc_jwt` em dados brutos não versionados).
   - _Motivo da rejeição:_ O desafio especifica autenticação de clientes via chave de API estática no cabeçalho HTTP (`x-api-key`). A inclusão de provedores externos de identidade introduz acoplamento de implantação e consumo de recursos sem pontuação correspondente na avaliação (§1 e §3).

6. **Encadeamento de blocos criptográficos no ledger (hash chain):**
   - _Padrão identificado:_ Presente em 3 repositórios (cluster `ledger_hash_chain` em dados brutos não versionados).
   - _Motivo da rejeição:_ A imutabilidade do histórico contábil é garantida no nível de banco por gatilhos restritivos contra `UPDATE`, `DELETE` e `TRUNCATE`, complementada pelo trigger de concordância postergada. O cálculo e validação sequencial de hashes adiciona complexidade computacional sem substituir a autoridade do catálogo relacional.

7. **Diário contábil em partidas dobradas com contrapartidas da instituição:**
   - _Padrão identificado:_ Presente em 7 repositórios (cluster `double_entry_journal` em dados brutos não versionados).
   - _Motivo da rejeição:_ As invariantes financeiras do desafio (§6) exigem o rastreamento linear de saldo de cada carteira com saldo anterior, saldo posterior e vínculo à transação da aposta. A criação de contas fictícias para partidas dobradas excede a modelagem requerida e eleva o custo de escrita sem exigência correlata no enunciado.

8. **Exclusão de mensagem original antes da confirmação de entrega na DLQ:**
   - _Padrão identificado:_ Observado em implementações de consumidores nas quais a exclusão da mensagem original no broker é executada de forma independente do retorno de gravação na DLQ.
   - _Motivo da rejeição:_ Se a chamada à DLQ falhar por problemas de rede após a mensagem ser descartada da fila principal, a mensagem é definitivamente perdida. O consumidor adotado garante que o delete da fila de origem ocorra unicamente após confirmação de recebimento pela fila de destino.

## 5. O que não foi verificado

1. **Execução de código de terceiros:** Nenhum artefato, teste ou script dos repositórios examinados foi executado em ambiente local ou contêiner (`npm install`, `bun test`, comandos de compilação ou execução de infraestrutura). A revisão limitou-se à leitura estática do código-fonte e análise documental, por diretriz de segurança operacional e integridade do ambiente.
2. **Afirmações de cobertura e volume de testes em READMEs:** Contagens de testes e relatórios de cobertura alegados por terceiros não foram auditados nem comprovados mediante execução.
3. **Forks sem implementação substantiva na triagem:** Dos 165 repositórios candidatos, 37 não foram lidos em profundidade por falta de arquivos de domínio ou migrações na triagem automatizada, e 6 foram excluídos na triagem qualitativa de dados brutos não versionados por ausência de implementação operacional.
4. **Branches secundários sem commits à frente da branch padrão:** Dos 129 registros de ramos não padrão catalogados em dados brutos não versionados, 119 apresentavam zero commits de avanço (`ahead_by=0`) e não foram submetidos a leitura específica de arquivos.
5. **Comparações de desempenho contra outras implementações:** Nenhuma medição de latência, taxa de transferência ou limites de concorrência foi realizada contra código de terceiros. As análises de desempenho do projeto referem-se estritamente à comparação interna entre alternativas do próprio código sob o mesmo ambiente de controle, registradas em [docs/audit/PERFORMANCE_COMPARISON.md](audit/PERFORMANCE_COMPARISON.md).
