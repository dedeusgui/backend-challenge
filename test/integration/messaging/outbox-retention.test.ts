import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroOrmOutboxStore } from '../../../src/modules/messaging/infrastructure/mikro-orm-outbox.store';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ verifyLedgerInvariant: false });
}, 60_000);

afterAll(async () => {
  await database.drop();
});

describe('outbox retention', () => {
  test('deletes only old published rows and drains more than one batch', async () => {
    const connection = database.orm.em.getConnection();
    const oldPublishedIds = Array.from({ length: 5 }, () => randomUUID());
    const recentId = randomUUID();
    const pendingId = randomUUID();
    const quarantinedId = randomUUID();
    const payload = JSON.stringify({
      eventId: randomUUID(),
      eventType: 'retention.test',
      aggregateId: 'aggregate',
      correlationId: 'correlation',
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {},
    });

    const insert = async (id: string, status: string, publishedAt: string | null) => {
      await connection.execute(
        `INSERT INTO outbox_messages
           (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, published_at, status)
         VALUES (?, 'aggregate', 'retention.test', ?::jsonb, now() - interval '10 days', now(),
                 CASE WHEN ?::text IS NULL THEN NULL ELSE now() - ?::interval END, ?)`,
        [id, payload, publishedAt, publishedAt, status],
      );
    };

    for (const id of oldPublishedIds) await insert(id, 'PUBLISHED', '10 days');
    await insert(recentId, 'PUBLISHED', '1 day');
    await insert(pendingId, 'PENDING', null);
    await insert(quarantinedId, 'QUARANTINED', null);

    const store = new MikroOrmOutboxStore(database.orm);
    const deleted = await store.deletePublishedBefore(new Date(Date.now() - 7 * 86_400_000), 2);

    expect(deleted).toBe(oldPublishedIds.length);
    const remaining = (await connection.execute(
      `SELECT id, status FROM outbox_messages ORDER BY id`,
    )) as Array<{ id: string; status: string }>;
    expect(remaining).toEqual(
      [
        { id: pendingId, status: 'PENDING' },
        { id: quarantinedId, status: 'QUARANTINED' },
        { id: recentId, status: 'PUBLISHED' },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
  });
});
