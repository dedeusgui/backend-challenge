# ADR 0004: Outbox with claim and lease, at-least-once delivery

**Status:** accepted

## Context

Events must not be published before their transaction commits, and must not be
lost once it has committed. Several publishers may run at once.

## Decision

- The event is written to `outbox_messages` in the same transaction as the financial
  change. Nothing is sent to SQS inside the transaction.
- A publisher claims due rows with one statement that uses `FOR UPDATE SKIP LOCKED`
  and sets a lease token and an expiry (`MikroOrmOutboxStore.claimDue`). Concurrent
  publishers take disjoint rows. The due check and the expiry use the database clock
  (`now()`), so the clock of a publisher cannot take a lease that another publisher
  holds.
- The broker send runs with no transaction open. The publisher then marks the row
  published **only if its lease token still matches** (`complete`). A lease that
  expired and was taken over makes the mark a no-op, which is reported
  (`outbox_lost_lease_total`).
- Failed sends are rescheduled with exponential backoff, and only under the lease.
- The event id is the outbox id and the SQS deduplication id. A crash after the
  broker accepted an event and before the mark causes a republication with the same
  id. Consumers deduplicate on it.

## Alternatives

- **Send inside the claim transaction**, as one reference project does. Simple,
  but the connection and the row lock are held for the whole broker call.
- **Publish from the request path after commit.** Loses events on a crash between
  commit and send.

## Consequences

- Delivery is at-least-once. Exactly-once is not claimed, and no SQS feature is
  relied on for it.
- Events of one wallet are grouped by the aggregate id, but publishers can still
  interleave. Consumers order by `walletVersion`.

## Evidence

- `test/integration/messaging/outbox-publisher.test.ts`: once-per-event, four
  publishers with no duplicate send, backoff, a lease taken over from a crashed
  publisher, and a stale token refused.
- `test/integration/faults/fault-injection.test.ts`: crash after the broker
  accepted and before the mark, republished with the same id, and the events queue
  keeps one copy inside the deduplication window.
