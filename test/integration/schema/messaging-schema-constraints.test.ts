import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sqlStateOf } from '../../support/sql-state';
import { type TestDatabase, createTestDatabase } from '../support/test-database';

/**
 * These tests bypass the application code on purpose: they prove that PostgreSQL
 * itself refuses invalid inbox and outbox rows. SQLSTATE code: 23505 unique.
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ verifyLedgerInvariant: false });
});

afterAll(async () => {
  await database.drop();
});

function sql(query: string, params: unknown[] = []): Promise<unknown> {
  return database.orm.em.getConnection().execute(query, params);
}

describe('inbox and outbox constraints', () => {
  test('deduplicates inbox messages by consumer and message id', async () => {
    const insertInbox = (consumerName: string) =>
      sql(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
         VALUES (?, 'msg-123', ?, now())`,
        [consumerName, 'b'.repeat(64)],
      );

    await insertInbox('wager-transactions');
    expect(await sqlStateOf(() => insertInbox('wager-transactions'))).toBe('23505');
    expect(await sqlStateOf(() => insertInbox('other-consumer'))).toBe('NO_ERROR');
  });

  test('keeps one outbox row per stable event id', async () => {
    const eventId = randomUUID();
    // The payload is a well-formed envelope: the shape constraint refuses anything else before this one applies.
    const payload = JSON.stringify({
      eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {},
    });
    const insertOutbox = () =>
      sql(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
         VALUES (?, 'wallet-1', 'WalletBalanceChanged', ?::jsonb, now(), now())`,
        [eventId, payload],
      );

    await insertOutbox();
    expect(await sqlStateOf(insertOutbox)).toBe('23505');
  });
});
