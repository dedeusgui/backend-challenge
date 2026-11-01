# ADR 0005: Retenção de transações para referências ausentes, com retentativas limitadas

**Status:** aceito

## Contexto

Provedores podem enviar um REFUND ou ROLLBACK antes da BET que ele reverte (desafio
§7.1). Tal transação não deve nem ser perdida nem aplicada antes de sua referência.

## Decisão

- Uma transação cuja referência está ausente é armazenada como `PENDING_REFERENCE`, com
  sua contagem de tentativas e próximo horário de consulta na linha. Um evento
  `WagerTransactionPendingReference` é gravado.
- `ProcessPendingReferences` (no worker) resolve cada linha devida sob o
  **bloqueio de carteira**, e a relê ali. Dois workers, portanto, nunca aplicam a mesma
  linha. A decisão é a mesma `TransactionSettlement` que o fluxo HTTP usa.
- As retentativas fazem backoff a partir de 1 s, dobrando, limitadas a 5 minutos. O limite é de seis ausências
  (`MAX_REFERENCE_ATTEMPTS`). Depois disso, a linha é `REJECTED` com
  `REFERENCE_NOT_FOUND`, e a recusa é anunciada.
- Uma referência que ainda está pendente faz a linha dependente esperar. Uma referência
  que foi recusada a torna `REFERENCE_NOT_PROCESSED`.

## Alternativas

- **Recusar imediatamente.** Perde reversões válidas que apenas chegaram fora de ordem.
- **Retentativas ilimitadas.** Uma referência que nunca chega seria tentada novamente para sempre,
  sem nenhum desfecho de auditoria.
- **Uma fila separada para retenções.** Mais infraestrutura, e o agendamento viveria
  fora da transação à qual pertence.

## Consequências

- Uma transação retida não é visível como aplicada, e seu saldo não é alterado.
  Seu estado indica o motivo.
- O agendamento está no PostgreSQL, portanto um worker reiniciado o retoma (`REF-04`).

## Evidências

- `test/integration/wagering/pending-reference.test.ts`: aplicada assim que a referência
  chega, backoff respeitado, esgotamento para REFERENCE_NOT_FOUND, continuação após
  uma reinicialização, e seis workers disputando seis reembolsos de uma carteira.
- `test/integration/faults/fault-injection.test.ts`: uma queda durante a resolução faz
  rollback, e a próxima passagem aplica o reembolso exatamente uma vez.
