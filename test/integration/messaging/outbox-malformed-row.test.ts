import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * The publisher reads every outbox payload as an integration envelope. A payload it cannot read
 * used to stop the whole claim: the store threw on the first one, the batch was never sent, and
 * the malformed row, being the oldest due one, was claimed first on every later pass. The schema
 * now refuses such a payload when it is written, so the publisher can rely on the shape it reads.
 */

const START = new Date('2026-07-29T15:00:00.000Z');

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

function validEnvelope(): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    eventType: 'WagerTransactionProcessed',
    aggregateId: randomUUID(),
    correlationId: randomUUID(),
    occurredAt: START.toISOString(),
    version: 1,
    data: { example: true },
  };
}

/** Resolves with true when the database accepted the row, false when it refused it. */
async function insertRow(payloadJson: string): Promise<boolean> {
  try {
    await database.orm.em.getConnection().execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
       VALUES (?, ?, ?, ?::jsonb, ?, ?)`,
      [randomUUID(), randomUUID(), 'WagerTransactionProcessed', payloadJson, START, START],
    );
    return true;
  } catch {
    return false;
  }
}

describe('outbox payload shape, enforced by the schema', () => {
  const malformed: Array<[string, unknown]> = [
    ['an empty object', {}],
    ['an object with unrelated keys', { unexpected: true }],
    ['a JSON string instead of an object', 'text'],
    ['no eventId', without(validEnvelope(), 'eventId')],
    ['an eventId that is a number', { ...validEnvelope(), eventId: 7 }],
    ['a version that is a string', { ...validEnvelope(), version: '1' }],
    ['no data', without(validEnvelope(), 'data')],
    ['an occurredAt that is a number', { ...validEnvelope(), occurredAt: 1 }],
  ];

  for (const [description, payload] of malformed) {
    test(`refuses ${description}`, async () => {
      expect(await insertRow(JSON.stringify(payload))).toBe(false);
    });
  }

  test('accepts a well-formed envelope, so the refusals above are not a blanket refusal', async () => {
    expect(await insertRow(JSON.stringify(validEnvelope()))).toBe(true);
  });
});

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}
