# Messaging recovery

Português: [Recuperação de mensageria](messaging-recovery.en.md).

## Context

Use this guide for command consumption, duplicate delivery, outbox, retries, DLQ, leases, shutdown, or crash recovery changes.

## Commands

- `bun run test:unit` covers consumer and publisher unit rules.
- `bun run test:integration` covers SQS, outbox, redrive, and failures; applicable tests require infrastructure.
- `bun run test:features` runs enabled messaging scenarios.
- `bun run outbox:requeue` is the operational requeue command defined in `package.json`.

## Invariants and evidence

- The consumer acknowledges only after commit; transient failures retry with backoff and permanent failures go to the DLQ: `src/modules/messaging/application/inbound/wager-command-consumer.ts`; [test](../../test/integration/messaging/wager-command-consumer.test.ts).
- Outbox publishing uses a lease and marks publication after transport acceptance: `src/modules/messaging/application/outbound/outbox-publisher.ts`; [test](../../test/integration/messaging/outbox-publisher.test.ts).
- A crash between send and marking may cause at-least-once delivery, so replay must be safe: [fault-injection test](../../test/integration/faults/fault-injection.test.ts).
- The redrive policy sends messages to the DLQ after ten deliveries: [broker-redrive test](../../test/integration/messaging/broker-redrive.test.ts).
- Schema constraints protect inbox/outbox identity and uniqueness: [constraints test](../../test/integration/schema/messaging-schema-constraints.test.ts).

## Completion

Check each message's final disposition, persisted state, and safe replay after failures. Finish with relevant tests passing and evidence that no message was acknowledged before commit.
