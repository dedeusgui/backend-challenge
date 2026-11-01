# Revisão simulada: barra e registro da rodada

Checkpoint da rodada de qualidade. Documenta a barra contra a qual o revisor simulado (o "avaliador Jungle") mede o projeto, a baseline medida e o que cada rodada entregou. A nota abaixo é uma estimativa interna, não a nota da banca.

## Baseline (commit `6da3cb6`, 2026-11-01)

`bun run check:all` com `infra:up` ativo: exit 0, 846 testes, 0 falhas, 1m48s.

| Suíte                                                   | Testes | Arquivos | Resultado |
| ------------------------------------------------------- | ------ | -------- | --------- |
| unitária (`check:fast` inclui typecheck, lint e format) | 484    | 43       | pass      |
| infraestrutura                                          | 4      | 1        | pass      |
| integração                                              | 235    | 29       | pass      |
| concorrência                                            | 23     | 5        | pass      |
| e2e                                                     | 100    | 9        | pass      |

## Barra

Meta: nota estimada ≥ 90/100, zero P1 e zero P2 abertos, `check:all` verde, matriz `PASSING` só para suíte rodada.

| Área (pts)                   | Barra | Evidência exigida                                                     | Situação na baseline         |
| ---------------------------- | ----- | --------------------------------------------------------------------- | ---------------------------- |
| Correção financeira (20)     | 19    | `Money` sem `number`; `wallet.balance == ledger`; reversões           | F-06 aguarda decisão do dono |
| Concorrência (20)            | 19    | §13 itens 1 a 8 com teste real; repetição sem falha                   | repetição não medida         |
| Idempotência (15)            | 14    | 50 envios paralelos geram 1 débito; payload divergente gera conflito  | ver evidência abaixo         |
| Mensageria e falhas (15)     | 14    | inbox, outbox, DLQ, crash entre commit e ack, shutdown                | ver evidência abaixo         |
| Modelagem e arquitetura (10) | 9     | entradas e saídas explícitas; portas em `ports/`; fronteiras testadas | F1 e F2 pendentes            |
| Testes (10)                  | 9     | integração real; Gherkin executável; invariante final no harness      | F3 pendente                  |
| Observabilidade (5)          | 5     | logs sem valores; métricas da §12; liveness e readiness separados     | ver evidência abaixo         |
| Documentação (5)             | 5     | setup no README; trade-offs no ARCHITECTURE; pares pt/en              | atualizar após F1 e F2       |

**Eliminatórias**, checadas em toda rodada: `number` para dinheiro; mock de PostgreSQL ou SQS em integração; publicação antes do commit; idempotência só em memória; ledger editável.

## Evidência verificada em F0

Estes itens eram alegação. Agora têm teste que rodou dentro do `check:all` de 6da3cb6.

- **§13.1, 50 envios paralelos → 1 débito:** `test/concurrency/hot-wallet.test.ts` ("50 identical requests in parallel") e `test/concurrency/three-processes.test.ts` ("fifty identical requests spread over three processes apply the debit exactly once").
- **§13.5, worker morto entre commit e ack:** `test/concurrency/three-processes.test.ts` (crash após commit e antes do ACK, recuperado por worker reiniciado), `test/integration/messaging/wager-command-consumer.test.ts` (crash após commit e antes da confirmação; crash após envio à DLQ e antes da confirmação).
- **§13.7, ROLLBACK ou REFUND antes da referência:** REFUND retido e aplicado depois do BET em `test/integration/wagering/pending-reference.test.ts`; ROLLBACK sem referência até o limite de tentativas em `test/integration/wagering/database-clock-references.test.ts` (linhas 158 a 191); ROLLBACK aplicado a um BET de três processos em `test/concurrency/distributed-contention.test.ts`.
- **Logs sem valores:** o formatador (`src/shared/observability/structured-log.ts`) escreve só campos declarados, sem payload nem valor.

Lacuna honesta: não há teste que comprove "ROLLBACK chega antes do BET e é aplicado depois". O que existe cobre a retenção e o limite de tentativas. Isto entra na F3 como cenário Gherkin.

## Registro da rodada

- F0: baseline registrada e evidência verificada. Sem mudança de código.
- Próximo: F1 (mapa de entradas e saídas em `ARCHITECTURE.md` §1).
