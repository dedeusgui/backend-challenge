# ADR 0004: Outbox com reivindicação e lease, entrega at-least-once

**Status:** aceito

## Contexto

Eventos não devem ser publicados antes do commit de sua transação, e não devem ser
perdidos depois que ela realizou o commit. Vários publicadores podem rodar ao mesmo tempo.

## Decisão

- O evento é gravado em `outbox_messages` na mesma transação que a alteração
  financeira. Nada é enviado ao SQS dentro da transação.
- Um publicador reivindica linhas devidas com uma única instrução que usa `FOR UPDATE SKIP LOCKED`
  e define um token de lease e uma expiração (`MikroOrmOutboxStore.claimDue`). Publicadores
  concorrentes pegam linhas disjuntas. A verificação de vencimento e a expiração usam o relógio do banco de dados
  (`now()`), de modo que o relógio de um publicador não pode tomar um lease que outro publicador
  mantém.
- O envio ao broker roda sem nenhuma transação aberta. O publicador então marca a linha
  como publicada **somente se o seu token de lease ainda coincidir** (`complete`). Um lease que
  expirou e foi assumido faz com que a marcação seja uma no-op, o que é informado
  (`outbox_lost_lease_total`).
- Envios com falha são reagendados com backoff exponencial, e apenas sob o lease. A próxima tentativa é
  o `now()` do banco de dados somado ao backoff, de modo que o relógio de um publicador não o encurte.
- O id do evento é o id do outbox e o id de deduplicação do SQS. Uma queda após o
  broker aceitar um evento e antes da marcação causa uma republicação com o mesmo
  id. Consumidores deduplicam por ele.

## Alternativas

- **Enviar dentro da transação de reivindicação**, como faz um projeto de referência. Simples,
  mas a conexão e o bloqueio de linha são mantidos durante toda a chamada ao broker.
- **Publicar a partir do fluxo da requisição após o commit.** Perde eventos em caso de queda entre
  o commit e o envio.

## Consequências

- A entrega é at-least-once. Exatamente-uma-vez (exactly-once) não é alegada, e nenhum recurso do SQS é
  usado como dependência para isso.
- Eventos de uma carteira são agrupados pelo id do agregado, mas publicadores ainda podem
  se intercalar. Consumidores ordenam por `walletVersion`.

## Evidências

- `test/integration/messaging/outbox-publisher.test.ts`: uma vez por evento, quatro
  publicadores sem envio duplicado, backoff, um lease assumido de um
  publicador com queda, e um token desatualizado recusado.
- `test/integration/faults/fault-injection.test.ts`: queda após o broker
  aceitar e antes da marcação, republicado com o mesmo id, e a fila de eventos
  mantém uma cópia dentro da janela de deduplicação.
