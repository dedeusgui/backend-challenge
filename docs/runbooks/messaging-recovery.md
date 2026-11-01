# Recuperação de mensageria

## Contexto

Use para alterar consumo de comandos, entrega duplicada, outbox, retries, DLQ, leases, shutdown ou recuperação após crash.

## Comandos

- `bun run test:unit` cobre regras unitárias do consumidor e publisher.
- `bun run test:integration` cobre SQS, outbox, redrive e falhas; requer infraestrutura nos testes aplicáveis.
- `bun run test:features` executa os cenários de mensageria habilitados.
- `bun run outbox:requeue` é o comando operacional de requeue definido em `package.json`.

## Invariantes e evidências

- O consumidor confirma mensagem só após commit; falhas transitórias voltam com backoff e falhas permanentes vão à DLQ: `src/modules/messaging/application/inbound/wager-command-consumer.ts`; [teste](../../test/integration/messaging/wager-command-consumer.test.ts).
- Publicação do outbox usa lease e marca publicação após aceite do transporte: `src/modules/messaging/application/outbound/outbox-publisher.ts`; [teste](../../test/integration/messaging/outbox-publisher.test.ts).
- Crash entre envio e marcação pode causar entrega ao menos uma vez, então replay deve ser seguro: [teste de fault injection](../../test/integration/faults/fault-injection.test.ts).
- A política de redrive envia mensagens após dez entregas à DLQ: [teste broker-redrive](../../test/integration/messaging/broker-redrive.test.ts).
- Identidade e unicidade inbox/outbox são protegidas pelo schema: [teste de constraints](../../test/integration/schema/messaging-schema-constraints.test.ts).

## Conclusão

Verifique a disposição final de cada mensagem, o estado persistido e a repetição segura após falhas. Termine com os testes pertinentes passando e evidência de que nenhuma mensagem foi confirmada antes do commit.
