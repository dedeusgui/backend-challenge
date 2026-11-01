# Defeitos, riscos e decisões desta rodada

Cada item tem a evidência que o demonstrou, a correção, o commit, o risco que resta e, quando for o caso, a
decisão que depende do dono do desafio. A matriz completa de cenários está em `EDGE_CASE_MATRIX.md`.

Base da rodada: `d65a1e7`. Linha de base: `BASELINE.md`.

## Resumo

| ID   | Título                                                                                    | Severidade                   | Status                                             | Evidência                                                                     | Commit                   |
| ---- | ----------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------ |
| F-01 | Um envelope malformado no outbox pára a publicação de todos os eventos atrás dele         | P1 (disponibilidade)         | Corrigido                                          | Teste: 8 casos falhavam antes; a publicação enviava 0 eventos com 3 pendentes | `2905535`                |
| F-02 | Mesmo `messageId` com `idempotencyKey` diferente era aceito como duplicata                | P2 (integridade da mensagem) | Corrigido, com compatibilidade para linhas antigas | Teste: 1 caso resolvia em vez de recusar                                      | `2ec4d5e`                |
| F-03 | Transação de outro provedor respondia 403, e o 404 de id inexistente revelava a diferença | P2 (segurança)               | Corrigido. **Mudança de contrato: aguarda o dono** | Teste: esperado 404, recebido 403                                             | `154b52a`                |
| F-04 | Lote lento deixava mensagens em voo visíveis para outro consumidor                        | P2 (operação)                | Corrigido                                          | Teste com LocalStack: o segundo consumidor recebeu 2 mensagens em voo         | `b398e22`                |
| F-05 | Hooks de falha de teste dentro do código de produção                                      | Regra do projeto             | Corrigido                                          | Composição em `assembleWorker`; suítes passam sem alterar as asserções        | `489df8b`                |
| F-06 | A concordância entre saldo e ledger não é garantida pelo esquema                          | P3 (defesa em profundidade)  | Aberto, com decisão. **Aguarda o dono**            | 3 escritas diretas aceitas pelo esquema atual                                 | experimento em `0f4fa19` |
| F-07 | O lease do outbox compara expiração com o relógio do chamador                             | P3 (duplicatas de envio)     | Aberto, reprodução pendente                        | Análise do código: `claimDue` recebe `now` do publicador                      | —                        |
| F-08 | O resumo do ledger na reconciliação era lido fora da transação                            | Robustez                     | Endurecido. Não reproduzido como defeito           | Leitura correta sob o lock; agora na transação                                | `0f4fa19`                |
| F-09 | O plano de consulta do ledger depende das estatísticas                                    | Observação                   | Monitorar com `EXPLAIN`                            | 1 mil lançamentos: varredura; 100 mil e 1 milhão: índice                      | —                        |
| F-10 | `ROLLBACK` do BET após o `ROLLBACK` do REFUND é recusado                                  | Decisão de contrato (D4)     | Comportamento fixado em teste. **Aguarda o dono**  | Teste existente                                                               | —                        |
| F-11 | Resultados sem referência não podem ser limitados a um por BET                            | Decisão de contrato (D1)     | Documentado                                        | Limitação inerente ao enunciado                                               | —                        |
| F-12 | A imagem Docker do repositório não constrói no sandbox                                    | Ambiente                     | Contornado para a demonstração                     | `bun install` falha com `SELF_SIGNED_CERT_IN_CHAIN`                           | —                        |

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

**Risco que resta.** Uma mensagem isolada mais longa que a janela ainda é reentregue. Está documentado em
`ARCHITECTURE`. O custo da chamada extra por mensagem não foi medido (ver `PERFORMANCE_COMPARISON.md`, experimento 2).

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

**Não feito nesta rodada.** Reprodução determinística entre dois hosts. A correção recomendada é usar o `now()` do
banco para expiração e para o vencimento. Isso obriga a reescrever ~25 pontos de teste que usam tempos sintéticos,
e não coube nesta rodada. Em `EDGE_CASE_MATRIX.md`, OB-07 está como `NOT_RUN`.

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

## F-11 — resultado sem referência

**Limitação inerente.** WIN e LOSS podem omitir a referência ao BET (§6.3, §7). Sem ela não há como saber qual
BET o resultado liquida, então "um resultado por BET" só vale para resultados vinculados. Dois WIN sem referência
para a mesma aposta são aceitos. A decisão D1 documenta isso. Não há correção possível sem o enunciado mudar, e
a regra que o enunciado impõe a REFUND e ROLLBACK é a que vale.

## F-12 — imagem Docker no sandbox

`docker compose up --build` falha no `bun install` da imagem, por `SELF_SIGNED_CERT_IN_CHAIN`: o proxy TLS da
sandbox não é confiável dentro do build. Isso já estava em `ARCHITECTURE` §14. Para executar a pilha, foi usada uma
imagem de teste **fora do repositório**, com uma cópia do `Dockerfile` que confia no CA da sandbox, e um
`docker-compose` override que aponta os três serviços para ela. O job `image` do CI construiu a imagem do
repositório com sucesso no commit `d65a1e7`.

---

## F-13 — FAILED não é alcançável por nenhum caminho de produção

**Evidência.** `WagerTransaction.fail` existe e tem testes, mas nenhum código de produção o chama. Uma falha permanente de
infraestrutura vai para a DLQ, sem linha `FAILED`. A especificação (§6.3) define FAILED como "erro permanente de
infraestrutura (terminal, auditável)".

**Situação.** O valor está na tabela de status e nas guardas, para que a regra exista. Nenhuma transação é gravada
como FAILED hoje. **Decisão do dono do desafio:** manter FAILED como auditoria da falha permanente, o que exige gravar a
linha num caminho que hoje só manda para a DLQ, ou remover o valor do enum e a transição. A escolha de remover é mais simples,
e a de gravar é a que a especificação descreve.

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

## Decisões que precisam do dono do desafio

5. **F-13:** FAILED, gravar a falha permanente de infraestrutura ou remover o valor.
1. **F-03:** a resposta 404 uniforme para transação alheia (mudança de um status documentado).
1. **F-06:** adotar ou não os triggers de concordância, pagando ~1,8 ms de lock sob contenção.
1. **F-10:** a leitura de D4 para ROLLBACK após desfazer REFUND.
1. **F-11:** D1, resultado sem referência, que não pode ser limitado a um por BET.
