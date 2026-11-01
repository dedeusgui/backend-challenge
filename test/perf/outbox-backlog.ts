/**
 * Backlog recovery of the outbox. It commits EVENTS unpublished events directly, then runs the publisher
 * until nothing is due, and prints one JSON line: how many events reached the events queue, how long it took,
 * and the rate. The publisher is the production class, with the production lease and a batch of BATCH events.
 * It runs on a fresh database and on the LocalStack broker of the test support, so `bun run infra:up` first.
 *
 *   EVENTS=5000 BATCH=20 bun run test/perf/outbox-backlog.ts
 *
 * One process drains the backlog, so this measures the publisher's recovery, not the consumers' throughput.
 */
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../integration/support/test-database';
import { createTestQueues, testSqsClient } from '../integration/support/sqs-test-queues';
import { OutboxPublisher } from '../../src/modules/messaging/application/outbox-publisher';
import { MikroOrmOutboxStore } from '../../src/modules/messaging/infrastructure/mikro-orm-outbox.store';
import { SqsEventTransport } from '../../src/modules/messaging/infrastructure/sqs/sqs-event-transport';
import { SqsQueue } from '../../src/modules/messaging/infrastructure/sqs/sqs-queue';

const EVENTS = Number(process.env.EVENTS ?? 2000);
const BATCH = Number(process.env.BATCH ?? 20);
const LEASE_MS = 30_000;

const database = await createTestDatabase({ verifyLedgerInvariant: false });
const sqs = testSqsClient();
const queues = await createTestQueues(sqs);
const connection = database.orm.em.getConnection();

await connection.execute(
  `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
   SELECT gen_random_uuid(), 'agg-' || g, 'WalletBalanceChanged',
          jsonb_build_object('eventId', gen_random_uuid()::text, 'eventType', 'WalletBalanceChanged',
            'aggregateId', 'agg-' || g, 'correlationId', 'corr', 'occurredAt', now()::text, 'version', 1,
            'data', jsonb_build_object('walletVersion', 1)),
          now(), now()
     FROM generate_series(1, ?) AS g`,
  [EVENTS],
);

const publisher = new OutboxPublisher({
  store: new MikroOrmOutboxStore(database.orm),
  transport: new SqsEventTransport(new SqsQueue(sqs, queues.eventsQueueUrl)),
  clock: () => new Date(),
  newLeaseToken: randomUUID,
  leaseDurationMs: LEASE_MS,
  batchSize: BATCH,
});

let published = 0;
const started = performance.now();
for (;;) {
  const pass = await publisher.publishOnce();
  if (pass === 0) {
    break;
  }
  published += pass;
}
const seconds = (performance.now() - started) / 1000;
const remaining = (await connection.execute(
  `SELECT count(*)::text AS n FROM outbox_messages WHERE published_at IS NULL`,
)) as Array<{ n: string }>;

console.log(
  JSON.stringify({
    events: EVENTS,
    batch: BATCH,
    published,
    remaining: remaining[0]?.n ?? 'unknown',
    seconds: Number(seconds.toFixed(2)),
    eventsPerSecond: Math.round(published / seconds),
  }),
);
await database.drop();
process.exit(0);
