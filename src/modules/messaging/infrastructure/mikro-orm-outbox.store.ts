import type { MikroORM } from '@mikro-orm/postgresql';
import type { IntegrationEnvelope } from '../../../shared/domain/integration-event';
import { OutboxMessage, retryDelayMs } from '../domain/outbox-message';
import type { ClaimRequest, OutboxStore } from '../application/ports/outbox-store';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string;
  status: 'PENDING' | 'PUBLISHED' | 'QUARANTINED';
}

interface IdRow {
  id: string;
}

function isOutboxRow(row: unknown): row is OutboxRow {
  if (typeof row !== 'object' || row === null) {
    return false;
  }
  return (
    'id' in row &&
    typeof row.id === 'string' &&
    'aggregate_id' in row &&
    typeof row.aggregate_id === 'string' &&
    'event_type' in row &&
    typeof row.event_type === 'string' &&
    'payload' in row &&
    'occurred_at' in row &&
    (row.occurred_at instanceof Date || typeof row.occurred_at === 'string') &&
    'attempts' in row &&
    typeof row.attempts === 'number' &&
    'next_attempt_at' in row &&
    (row.next_attempt_at instanceof Date || typeof row.next_attempt_at === 'string') &&
    'status' in row &&
    (row.status === 'PENDING' || row.status === 'PUBLISHED' || row.status === 'QUARANTINED')
  );
}

function isIdRow(row: unknown): row is IdRow {
  return typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEnvelope(record: Record<string, unknown>): record is IntegrationEnvelope<unknown> {
  return (
    typeof record.eventId === 'string' &&
    typeof record.eventType === 'string' &&
    typeof record.aggregateId === 'string' &&
    typeof record.correlationId === 'string' &&
    typeof record.occurredAt === 'string' &&
    typeof record.version === 'number' &&
    'data' in record &&
    (!('causationId' in record) ||
      record.causationId === undefined ||
      typeof record.causationId === 'string')
  );
}

/**
 * Raw SQL on purpose: the claim is one UPDATE with a subquery, and FOR UPDATE SKIP
 * LOCKED lets concurrent publishers take disjoint rows without waiting on each other.
 */
export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(request: ClaimRequest): Promise<OutboxMessage[]> {
    // Every time in this statement is the database's now(). Order the claimed batch by due time and occurrence.
    // Retries and concurrent publishers can still emit wallet events out of order; consumers order them by walletVersion.
    const result: unknown = await this.orm.em.getConnection().execute(
      `WITH claimed AS (
         UPDATE outbox_messages
            SET lease_token = ?, lease_expires_at = now() + make_interval(secs => ?)
          WHERE id IN (
            SELECT id FROM outbox_messages
             WHERE published_at IS NULL
               AND status = 'PENDING'
               AND next_attempt_at <= now()
               AND (lease_expires_at IS NULL OR lease_expires_at < now())
             ORDER BY next_attempt_at, occurred_at
             LIMIT ?
             FOR UPDATE SKIP LOCKED)
         RETURNING id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, status
       )
       SELECT * FROM claimed ORDER BY next_attempt_at, occurred_at`,
      [request.token, request.leaseMs / 1000, request.limit],
    );
    if (!Array.isArray(result) || !result.every(isOutboxRow)) {
      throw new Error('Unexpected query result: expected OutboxRow[]');
    }
    return result.map(toDomain);
  }

  async complete(
    messages: readonly OutboxMessage[],
    token: string,
    at: Date,
  ): Promise<readonly string[]> {
    if (messages.length === 0) {
      return [];
    }
    // One placeholder per id: the driver expands an array parameter into a list, not into an array value.
    const placeholders = messages.map(() => '?').join(', ');
    const result: unknown = await this.orm.em.getConnection().execute(
      `UPDATE outbox_messages
          SET published_at = ?, status = 'PUBLISHED', lease_token = NULL, lease_expires_at = NULL
        WHERE lease_token = ? AND id IN (${placeholders})
       RETURNING id`,
      [at, token, ...messages.map((message) => message.id)],
    );
    if (!Array.isArray(result) || !result.every(isIdRow)) {
      throw new Error('Unexpected query result: expected IdRow[]');
    }
    return result.map((row) => row.id);
  }

  async reschedule(message: OutboxMessage, token: string, maxAttempts = 10): Promise<boolean> {
    const result: unknown = await this.orm.em.getConnection().execute(
      `UPDATE outbox_messages
          SET attempts = ?, status = CASE WHEN ? >= ? THEN 'QUARANTINED' ELSE 'PENDING' END,
              next_attempt_at = CASE WHEN ? >= ? THEN next_attempt_at ELSE now() + make_interval(secs => ?) END,
              lease_token = NULL, lease_expires_at = NULL
        WHERE id = ? AND lease_token = ?
       RETURNING id`,
      [
        message.attempts,
        message.attempts,
        maxAttempts,
        message.attempts,
        maxAttempts,
        retryDelayMs(message.attempts) / 1000,
        message.id,
        token,
      ],
    );
    if (!Array.isArray(result) || !result.every(isIdRow)) {
      throw new Error('Unexpected query result: expected IdRow[]');
    }
    return result.length === 1;
  }

  async requeue(id: string): Promise<boolean> {
    const result: unknown = await this.orm.em.getConnection().execute(
      `UPDATE outbox_messages SET status = 'PENDING', attempts = 0, next_attempt_at = now(),
                                  lease_token = NULL, lease_expires_at = NULL
        WHERE id = ? AND status = 'QUARANTINED' RETURNING id`,
      [id],
    );
    if (!Array.isArray(result) || !result.every(isIdRow)) {
      throw new Error('Unexpected query result: expected IdRow[]');
    }
    return result.length === 1;
  }

  async deletePublishedBefore(cutoff: Date, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Outbox retention batch size must be a positive integer');
    }
    let deleted = 0;
    while (true) {
      const result: unknown = await this.orm.em.getConnection().execute(
        `WITH expired AS (
           SELECT id FROM outbox_messages
            WHERE status = 'PUBLISHED' AND published_at IS NOT NULL AND published_at < ?
            ORDER BY published_at, id
            LIMIT ?
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM outbox_messages AS messages
          USING expired
          WHERE messages.id = expired.id
         RETURNING messages.id`,
        [cutoff, limit],
      );
      if (!Array.isArray(result) || !result.every(isIdRow)) {
        throw new Error('Unexpected query result: expected IdRow[]');
      }
      deleted += result.length;
      if (result.length < limit) {
        return deleted;
      }
    }
  }
}

function toDomain(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: parseEnvelope(row.payload),
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    publishedAt: undefined,
    quarantined: row.status === 'QUARANTINED',
  });
}

/** The payload was written by this system, but it is still read from the database as unknown and checked. */
function parseEnvelope(value: unknown): IntegrationEnvelope<unknown> {
  if (!isRecord(value)) {
    throw new Error('Outbox payload is not an object');
  }
  const envelope = value;
  for (const key of ['eventId', 'eventType', 'aggregateId', 'correlationId', 'occurredAt']) {
    if (typeof envelope[key] !== 'string') {
      throw new Error(`Outbox payload is missing ${key}`);
    }
  }
  if (typeof envelope.version !== 'number' || !('data' in envelope)) {
    throw new Error('Outbox payload has an invalid version or data');
  }
  if (!isEnvelope(envelope)) {
    throw new Error('Outbox payload has an invalid version or data');
  }
  return envelope;
}
