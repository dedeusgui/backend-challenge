# Defeitos, riscos e decisões desta rodada

Cada item tem a evidência que o demonstrou, a correção, o commit, o risco que resta e, quando for o caso, a
decisão que depende do dono do desafio. A matriz completa de cenários está em `EDGE_CASE_MATRIX.md`.

Base da rodada: `d65a1e7`. Linha de base: `BASELINE.md`.

## Resumo

| ID   | Título                                                                                    | Severidade                              | Status                                                                               | Evidência                                                                                    | Commit                                   |
| ---- | ----------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| F-01 | Um envelope malformado no outbox pára a publicação de todos os eventos atrás dele         | P1 (disponibilidade)                    | Corrigido                                                                            | Teste: 8 casos falhavam antes; a publicação enviava 0 eventos com 3 pendentes                | `2905535`                                |
| F-02 | Mesmo `messageId` com `idempotencyKey` diferente era aceito como duplicata                | P2 (integridade da mensagem)            | Corrigido, com compatibilidade para linhas antigas                                   | Teste: 1 caso resolvia em vez de recusar                                                     | `2ec4d5e`                                |
| F-03 | Transação de outro provedor respondia 403, e o 404 de id inexistente revelava a diferença | P2 (segurança)                          | Defeito corrigido; eventual interpretação alternativa é questão para a Jungle Gaming | Teste: esperado 404, recebido 403                                                            | `154b52a`                                |
| F-04 | Lote lento deixava mensagens em voo visíveis para outro consumidor                        | P2 (operação)                           | Corrigido                                                                            | Teste com LocalStack: o segundo consumidor recebeu 2 mensagens em voo                        | `b398e22`                                |
| F-05 | Hooks de falha de teste dentro do código de produção                                      | Regra do projeto                        | Corrigido                                                                            | Composição em `assembleWorker`; suítes passam sem alterar as asserções                       | `489df8b`                                |
| F-06 | A concordância entre saldo e ledger não é garantida pelo esquema                          | P3 (defesa em profundidade)             | Corrigido pela migração 12 (`c5ddca9`)                                               | Evidência histórica antes da migração 12: três escritas diretas eram aceitas                 | descoberta `0f4fa19`; correção `c5ddca9` |
| F-07 | O lease do outbox compara expiração com o relógio do chamador                             | P3 (duplicatas de envio)                | Corrigido. Posse decidida pelo `now()` do banco                                      | Dois testes, relógio uma hora atrás e uma hora à frente, tomavam 6 eventos de um lease ativo | —                                        |
| F-08 | O resumo do ledger na reconciliação era lido fora da transação                            | Robustez                                | Endurecido. Não reproduzido como defeito                                             | Leitura correta sob o lock; agora na transação                                               | `0f4fa19`                                |
| F-09 | O plano de consulta do ledger depende das estatísticas                                    | Observação                              | Monitorar com `EXPLAIN`                                                              | 1 mil lançamentos: varredura; 100 mil e 1 milhão: índice                                     | —                                        |
| F-10 | `ROLLBACK` do BET após o `ROLLBACK` do REFUND é recusado                                  | Decisão técnica (D4)                    | Confirmada em 2026-11-01; interpretação adicional ao texto literal                   | Teste existente                                                                              | —                                        |
| F-11 | Resultados sem referência não podem ser limitados a um por BET                            | Limitação técnica (D1)                  | Confirmada em 2026-11-01                                                             | Limitação inerente ao enunciado                                                              | —                                        |
| F-12 | A imagem Docker do repositório não constrói no sandbox                                    | Ambiente                                | Contornado para a demonstração                                                       | `bun install` falha com `SELF_SIGNED_CERT_IN_CHAIN`                                          | —                                        |
| F-13 | FAILED sem caminho de produção; uma retenção com falha permanente travava as demais       | P2 (fila de retenções; auditoria)       | Defeito corrigido; adequação contratual só a Jungle Gaming pode esclarecer           | Teste com carteira ilegível: a passagem falhava e a retenção saudável não era resolvida      | —                                        |
| F-14 | Mensagem isolada mais longa que a janela de visibilidade era reentregue                   | P2 (duplicidade de entrega)             | Corrigido, com limite de retenção                                                    | Teste com LocalStack: o segundo consumidor recebia a mensagem aos 3,5 s                      | —                                        |
| F-15 | O worker decide o prazo de referência pelo próprio relógio                                | P2 (decisão financeira depende do host) | Corrigido                                                                            | Relógio uma hora à frente consumia tentativa antes do prazo; agenda gravada 3601 s adiante   | `fc3862c`                                |

---

## F-01 — envelope malformado no outbox pára a publicação

**Evidência.** `test/integration/messaging/outbox-malformed-row.test.ts`, primeira versão: inserido um payload
`{ unexpected: true }` com a data mais antiga, e dois eventos válidos. Um publicador, três passagens com o
relógio avançando além do lease. O resultado foi `Outbox payload is missing eventId` ao reivindicar o lote, nenhum
evento enviado, e três linhas pendentes. A causa: `claimDue` converte cada linha e lança na primeira inválida,
depois de o `UPDATE` já ter gravado os leases. A linha inválida, sendo a mais antiga, volta primeiro em toda
reivindicação.

**Correção.** Migration 9: CHECK sobre `outbox_messages.payload` que exige os campos do envelope com seus tipos,
com `IS NOT DISTINCT FROM`. Uma primeira versão usava `=`, e o teste pegou a falha: um campo ausente produz NULL,
e um CHECK que avalia para NULL passa. A escrita malformada agora falha a transação financeira que a produziria,
o que torna o erro de produção visível no ponto em que nasce.

**Verificação.** Oito casos de recusa passam (vazio, chaves não relacionadas, string, `eventId` ausente, `eventId`
numérico, `version` string, `data` ausente, `occurredAt` numérico), e um envelope válido é aceito. A migration foi
aplicada no banco de desenvolvimento com 34 linhas de outbox, nenhuma violando a regra, e o contêiner `migrate`
terminou com código 0.

**Risco que resta.** `parseEnvelope` continua lançando diante de uma linha que escape ao CHECK. Isso não pode
acontecer por escrita da aplicação. Pode acontecer por escrita manual, e aí o publicador para em vez de publicar
o lote sem a linha, o que é intencional: uma falha ruidosa.

## F-02 — `idempotencyKey` fora da identidade da mensagem

**Evidência.** `test/integration/messaging/inbox-message-identity.test.ts`. A inbox gravava um hash só dos campos de
negócio. Com o mesmo `messageId`, a mesma transação de negócio e outra `idempotencyKey`, o processamento devolvia
replay e a mensagem era confirmada. O teste esperava `MESSAGE_PAYLOAD_CONFLICT` e não recebeu nada (resolveu).

**Efeito financeiro.** Nenhum. A identidade de negócio é o external id, e o replay responde o mesmo resultado. O
defeito está na detecção: uma mensagem alterada foi tratada como duplicata legítima.

**Correção.** `wagerMessageFingerprint` cobre os campos de negócio e a `idempotencyKey`. Linhas novas gravam essa
fingerprint. O hash de transação (`payloadHash`) não muda: a identidade da transação continua sendo a key com o
payload. **Compatibilidade:** linhas gravadas antes da correção guardam só o hash de negócio, e um redelivery
delas continua comparado só pelos campos de negócio. Um teste fixa essa regra.

**Risco que resta.** Mensagens recebidas antes da correção, com `messageId` reutilizado e só a key alterada, ainda
são aceitas. É uma janela limitada às mensagens já gravadas.

## F-03 — 403 revelava a existência de transação alheia

**Evidência.** `test/e2e/authorization-adversarial.test.ts`. Uma chave de provedor válida lia
`GET /wagering/transactions/:id`. O id inexistente respondia 404, e o id de outro provedor respondia 403. Com UUIDv7,
o custo de sondar é baixo. O próprio teste afirmava a diferença como esperada.

**Correção.** Transação fora do escopo responde `404 TRANSACTION_NOT_FOUND`, a mesma resposta do id inexistente. Os
corpos diferem só no id pedido, e um teste verifica isso. A rota por provedor (`/providers/:id/...`) mantém 403 para
um caminho que não é do chamador, porque essa resposta não depende de nenhuma transação. OpenAPI, `ARCHITECTURE` §12,
ADR 0007 e o guia do revisor foram atualizados.

**Decisão do dono.** A mudança altera um status documentado. `ARCHITECTURE` §12 afirmava que o 403 era mantido de
propósito, e dizia que a resposta uniforme exigia a decisão do dono. A rodada a aplicou, por instrução do
desafio de investigar e documentar essa mudança. **O dono deve confirmar ou reverter.** A reversão é uma linha
na consulta.

## F-04 — mensagens em voo visíveis para outro consumidor

**Evidência.** `test/integration/messaging/visibility-during-batch.test.ts`, contra LocalStack. Janela de visibilidade
de 2 s, cada transação parada 1,2 s, segundo consumidor consultando em 2,2 s. Antes da correção, o segundo consumidor
recebeu duas mensagens que o primeiro ainda processava.

**Por que importa.** O efeito financeiro é idempotente, mas cada entrega conta para o limite de redrive de dez. Um
lote lento podia mandar à DLQ uma mensagem que já tinha sido aplicada.

**Correção.** Antes de cada mensagem após a primeira, o consumidor renova a visibilidade de todas as que ainda
esperam, com uma chamada `ChangeMessageVisibilityBatch`. Uma entrada recusada rejeita a chamada, e o lote falha
fechado. A porta de fila ganhou `extendVisibility`, com a implementação SQS e os dois adaptadores de teste.

**Risco que resta.** Uma mensagem isolada mais longa que a janela era reentregue; corrigido em F-14. O custo da chamada extra por mensagem não foi medido (ver `PERFORMANCE_COMPARISON.md`, experimento 2).

## F-05 — ganchos de falha dentro do código de produção

**Evidência.** `CLAUDE.md` diz que ganchos de falha são só de teste. O consumidor tinha `ConsumerFaults` com um
padrão de não-operação, e o runtime do worker tinha `faults` e `decorateUnitOfWork`, usados só pelos workers de
teste.

**Correção.** `connectWorkerDependencies` abre o banco e as filas. `assembleWorker` monta consumidor, publicador e
resolvedor de referências a partir de dependências dadas. `createWorkerRuntime` é a entrada de produção, e é a
soma das duas. Os pontos de falha vivem em `test/support/worker-seams.ts`, e os três workers de teste os compõem.
As asserções das suítes de mensageria e concorrência não mudaram (68 testes). O teste de falha após o commit trocou o
gancho por um wrapper da fila, que falha no primeiro ACK: a mesma falha, no mesmo ponto.

## F-06 — concordância entre saldo e ledger não garantida pelo esquema

**Evidência.** `test/experiments/ledger-agreement-triggers.test.ts`. Sem o candidato, o esquema aceita três escritas
diretas que violam a invariante 6.2: alterar o saldo sem lançamento, lançar sem continuar a cadeia, e lançar um
saldo final diferente do saldo da wallet. As três falharam antes do candidato. Com ele, são recusadas no `COMMIT`.

**Medição.** Seis rodadas alternadas, duas execuções independentes. A mediana do p50 sob oito workers numa wallet
quente subiu 1,8 ms (+4,7%), porque as verificações rodam no `COMMIT`, com o lock da wallet ainda ativo. A cauda
do mesmo cenário mudou +0,5 ms numa execução e +8,5 ms na outra. Seis rodadas não delimitam o p99.

**Decisão.** Não adotado no caminho de escrita. A especificação pede unicidade, imutabilidade e não-negatividade
no esquema (§5.9). A concordância é invariante (§6.2), verificada pela reconciliação e pelo teardown das suítes.
O custo fica registrado em `PERFORMANCE_COMPARISON.md`, e o candidato está em
`docs/audit/experiments/ledger-agreement-triggers.sql`, pronto para virar migration.

**Decisão do dono.** Se houver exigência de proteção contra escrita fora da aplicação, o candidato é a
alternativa, pagando o custo medido.

## F-07 — lease do outbox usa o relógio do chamador

**Evidência.** Leitura de `MikroOrmOutboxStore.claimDue`: `lease_expires_at < ?` e `next_attempt_at <= ?` usam o
`now` que o publicador passa, e `leaseUntil` também é calculado no publicador. Um publicador com relógio adiantado
pode tomar um lease ainda válido no banco. Os testes de lease usam tempos sintéticos (2026-07-29), o que mostra que o
desenho depende do relógio do chamador.

**Efeito.** Duplicata de envio no broker de eventos. A marcação continua protegida pelo token do lease (a
publicação atrasada não marca como enviada), e os consumidores deduplicam por `eventId`. Não há efeito financeiro.

**Correção.** O `claimDue` passou a usar `now()` do banco para o vencimento, a posse e a expiração
(`lease_expires_at = now() + make_interval(...)`). O publicador informa apenas o token e a duração. A reprodução é
`test/integration/messaging/outbox-lease-clock.test.ts`, com dois casos: publicador uma hora atrás e uma hora
adiantado. Antes da correção, cada um tomava 6 eventos de um lease ativo de outro publicador. Os demais testes de
tempo avançam o relógio do banco com `advanceOutboxClock`, em vez de passar um `now` sintético.

**Também corrigido nesta rodada.** O agendamento de nova tentativa usava o relógio do publicador. Com o relógio uma
hora atrás, um evento recusado voltava a ser enviado a cada passagem, sem backoff. Agora o `reschedule` grava
`now() + backoff` no banco (`test/integration/messaging/outbox-retry-clock.test.ts`). O instante de publicação e a
métrica de atraso ainda usam o relógio do publicador: não decidem estado.

## F-08 — leitura do resumo fora da transação

**Análise.** `summarize` lia o ledger pelo pool, não pela transação. A reconciliação já segurava o lock de
compartilhamento da wallet antes dessa leitura, e um escritor não pode confirmar enquanto o lock estiver
ativo, então o resultado era correto. A correção era correta, mas dependia do tempo.

**Mudança.** A leitura passou a usar `em.execute`, que respeita a transação. Os testes de reconciliação e de
carteira passam sem alteração.

## F-09 — plano de consulta do ledger depende das estatísticas

**Observação medida.** Com 1 mil lançamentos em 10 wallets, o planejador escolheu uma varredura regressiva por
`ledger_seq_key`, com filtro por `wallet_id`: 0,68 ms. Com 100 mil e 1 milhão de lançamentos, escolheu
`ledger_wallet_seq_idx`: 0,44 e 0,50 ms. A varredura é O(n) no pior caso, mas não foi escolhida no tamanho
grande.

**Ação.** Nenhuma alteração. Em produção, `EXPLAIN` sobre `WHERE wallet_id = ? ORDER BY seq DESC LIMIT 1` deve ser
verificado com o tamanho real.

## F-10 — ROLLBACK do BET após o ROLLBACK do REFUND

**Comportamento atual.** Um REFUND é desfeito por um ROLLBACK, e depois um ROLLBACK do BET é recusado com
`REFERENCE_ALREADY_REVERSED`. O teste "a ROLLBACK of a REFUND takes the stake back, and the BET cannot be reversed
again afterwards" fixa esse comportamento.

**Por que é decisão.** A regra 4 do enunciado diz "não pode ser revertida duas vezes pelo mesmo tipo de operação".
A leitura adotada é que uma referência é revertida no máximo uma vez, qualquer que seja o tipo (D4). Com a leitura
literal, REFUND seguido de ROLLBACK creditaria a aposta duas vezes. Desfazer o REFUND não reabre o BET nessa leitura.
**O dono deve confirmar.** Se a leitura for outra, a mudança é em `processedOutcomesOf`, e o teste precisa mudar
junto.

**Proposta do dono desta rodada.** "Se houve rollback e uma operação final, o refund seria recusado, porque a operação já
foi revertida." O comportamento atual é esse: `decideAgainstHistory` em `wager-lifecycle.ts` recusa qualquer
operação contra uma referência já revertida, com `REFERENCE_ALREADY_REVERSED`. A tabela de decisão de cada tipo
contra cada histórico está testada (16 casos). O que resta em aberto é só o caso de ROLLBACK depois de desfazer um
REFUND, que a proposta não cobre. A leitura atual (recusar) é a mesma do caso de REFUND depois de rollback.

## F-11 — resultado sem referência

**Limitação conhecida; decisão D1 confirmada em 2026-11-01.** WIN e LOSS podem omitir a referência ao BET (§6.3, §7). Sem ela não há como saber qual BET o resultado liquida, então "um resultado por BET" só vale para resultados vinculados. Dois WIN sem referência para a mesma aposta são aceitos. É interpretação aplicada ao enunciado, não aprovação interna pendente; somente a Jungle Gaming pode esclarecer se pretendia semântica diferente.

## F-12 — imagem Docker no sandbox

`docker compose up --build` falha no `bun install` da imagem, por `SELF_SIGNED_CERT_IN_CHAIN`: o proxy TLS da
sandbox não é confiável dentro do build. Isso já estava em `ARCHITECTURE` §14. Para executar a pilha, foi usada uma
imagem de teste **fora do repositório**, com uma cópia do `Dockerfile` que confia no CA da sandbox, e um
`docker-compose` override que aponta os três serviços para ela. O job `image` do CI construiu a imagem do
repositório com sucesso no commit `d65a1e7`.

---

## F-13 — FAILED não tinha caminho de produção, e uma retenção com falha permanente travava as demais

**Evidência.** `test/integration/wagering/held-failure.test.ts`, contra PostgreSQL. Uma retenção cuja resolução falhava de
forma permanente (carteira ilegível) fazia `runOnce` lançar o erro. Como a consulta ordena pela agenda, a mesma linha
voltava primeiro em toda passagem, e as retenções seguintes nunca eram resolvidas. Antes da correção o teste falhava com
`WalletNotFoundError`, e a retenção saudável continuava `PENDING_REFERENCE`. Nenhum código de produção gravava `FAILED`.

**Correção.** A falha permanente de uma retenção é registrada como `FAILED`, com `PROCESSING_FAILED` e o saldo com que
ela foi retida. O registro é feito em uma unidade de trabalho própria, depois que a tentativa foi desfeita, e é
anunciado por `WagerTransactionFailed`. A passagem segue para as demais. Uma falha transitória não é registrada: ela
encerra a passagem com o erro, e a linha é consultada de novo. O classificador de falhas foi movido para
`src/shared/application`, porque o worker de referências também o usa.

**Decisão a confirmar pelo dono.** Escolhi gravar FAILED, como descreve a especificação (§6.3), em vez de remover o valor.
Isso acrescenta o evento `WagerTransactionFailed`, que a especificação não lista. Uma transação que falha antes de ser
retida não é gravada: vai para a DLQ, ou a HTTP responde com o erro, como antes. `PENDING → FAILED` continua no domínio,
sem caminho de produção.

## F-14 — mensagem isolada mais longa que a janela de visibilidade era reentregue

**Evidência.** `test/integration/messaging/slow-message-hold.test.ts`, contra LocalStack. Janela de 2 s e processamento de
6 s: o segundo consumidor, consultando aos 3,5 s, recebia a mensagem que o primeiro ainda processava. A renovação do
F-04 só cobria as mensagens seguintes do lote.

**Correção.** Enquanto o próprio comando roda, a mensagem é renovada a cada terço da janela, até um limite de retenção
de 300 s (`holdLimitSeconds`). Uma renovação recusada pelo broker encerra as renovações. Passado o limite, a mensagem é
liberada, para que um processador travado não a retenha para sempre. Teste unitário sem broker:
`test/unit/messaging/application/wager-command-hold.test.ts`.

**Limite.** Passado o limite de retenção, dois consumidores podem processar o mesmo comando ao mesmo tempo. A identidade
da transação mantém o efeito em um: o teste de limite afirma o saldo de 99,00 depois dos dois. Um comando mais lento que
o limite roda em duplicidade. O custo de uma renovação a cada terço da janela não foi medido.

## F-15 — o worker decide o prazo de referência pelo próprio relógio

**Evidência.** `test/integration/wagering/database-clock-references.test.ts`, contra PostgreSQL. Com o relógio de um
worker uma hora à frente, uma referência ainda não vencida era consultada, e uma tentativa era consumida antes do prazo.
Com o relógio uma hora atrás, uma referência vencida no banco não era consultada. A agenda gravada por um worker adiantado
ficava 3601 s à frente.

**Por que importa.** A regra "seis consultas sem resposta levam a REFERENCE_NOT_FOUND" passava a depender de qual host
rodava o worker. A matriz dizia "sem efeito financeiro", e isso estava errado: um estorno podia ser rejeitado mais cedo
ou ficar parado mais tempo, conforme o relógio do host que consultou.

**Correção.** A porta `DatabaseClock` lê `now()` na própria unidade de trabalho. O vencimento em
`ProcessPendingReferences` e a agenda gravada em `TransactionSettlement` usam esse instante. O relógio do worker
ficou apenas nos instantes dos eventos, que não decidem estado.

**Risco que resta.** Nenhum conhecido nesse caminho. O custo de uma consulta a `now()` em cada primeira falha não foi
medido (ver `PERFORMANCE_COMPARISON.md`).

## Execução do demo

`bun run demo:finance`, contra a pilha em execução com as imagens construídas a partir do código atual (inclusive a
migration 9). Resultado: **rc 0**, com todas as verificações do roteiro: BET, WIN, REFUND e ROLLBACK com os saldos
esperados; segundo ROLLBACK recusado com `REFERENCE_ALREADY_REVERSED`; replay com o saldo observado; soma do ledger
igual ao saldo (75,00); reconciliação consistente.

## Não executado nesta rodada

| Item                                                                   | Motivo                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `bun run test:load` pareado (experimento 2 e carga geral)              | O harness constrói a imagem pelo Compose, o que o sandbox não faz. Um caminho alternativo exigiria alterar o harness |
| `bun run test:edge`                                                    | Exige `docker-compose.protected.yml` com `--build`                                                                   |
| Reprodução de F-07 entre dois hosts                                    | Não coube nesta rodada. Ver F-07                                                                                     |
| TX-19, PR-06, PR-07, ID-10 da matriz                                   | Sem teste nesta rodada. Ver `EDGE_CASE_MATRIX.md`                                                                    |
| Testes baseados em propriedades (Money, ledger) e de modelo com estado | Não adicionados nesta rodada. Nenhuma dependência nova foi introduzida                                               |
| Mutation testing das invariantes                                       | Não executado                                                                                                        |
| Soak test e teste de recuperação de backlog                            | Não executados                                                                                                       |
| Verificação da vitrine pública do GitHub Pages                         | URL inacessível pelo sandbox                                                                                         |

## Questões de contrato que somente a Jungle Gaming pode esclarecer

D1–D4 foram confirmadas em 2026-11-01. F-03 e F-13 têm defeitos de implementação corrigidos; se as escolhas de contrato correspondem à intenção original do enunciado, somente a Jungle Gaming pode esclarecer. F-06 foi corrigido pela migração 12 (`c5ddca9`), com gatilhos de concordância entre saldo e ledger. Nenhuma dessas questões é uma aprovação interna pendente.
