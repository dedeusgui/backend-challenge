import type { MikroORM } from '@mikro-orm/postgresql';
import type { IntegrationEnvelope } from '../../../shared/domain/integration-event';
import { OutboxMessage, retryDelayMs } from '../domain/outbox-message';
import type { ClaimRequest, OutboxStore } from '../application/ports/outbox-store';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  status: 'PENDING' | 'PUBLISHED' | 'QUARANTINED';
}

/**
 * Raw SQL on purpose: the claim is one UPDATE with a subquery, and FOR UPDATE SKIP
 * LOCKED lets concurrent publishers take disjoint rows without waiting on each other.
 */
export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(request: ClaimRequest): Promise<OutboxMessage[]> {
    // Every time in this statement is the database's now(). The UPDATE returns its rows in no particular order, so the
    // order is applied after it: a batch is sent in the order its events became due, and the events of one wallet keep
    // their commit order.
    const rows = (await this.orm.em.getConnection().execute(
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
    )) as OutboxRow[];
    return rows.map(toDomain);
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
    const rows = (await this.orm.em.getConnection().execute(
      `UPDATE outbox_messages
          SET published_at = ?, status = 'PUBLISHED', lease_token = NULL, lease_expires_at = NULL
        WHERE lease_token = ? AND id IN (${placeholders})
       RETURNING id`,
      [at, token, ...messages.map((message) => message.id)],
    )) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  async reschedule(message: OutboxMessage, token: string, maxAttempts = 10): Promise<boolean> {
    const rows = (await this.orm.em.getConnection().execute(
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
    )) as Array<{ id: string }>;
    return rows.length === 1;
  }

  async requeue(id: string): Promise<boolean> {
    const rows = (await this.orm.em.getConnection().execute(
      `UPDATE outbox_messages SET status = 'PENDING', attempts = 0, next_attempt_at = now(),
                                  lease_token = NULL, lease_expires_at = NULL
        WHERE id = ? AND status = 'QUARANTINED' RETURNING id`,
      [id],
    )) as Array<{ id: string }>;
    return rows.length === 1;
  }

  async deletePublishedBefore(cutoff: Date, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Outbox retention batch size must be a positive integer');
    }
    let deleted = 0;
    while (true) {
      const rows = (await this.orm.em.getConnection().execute(
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
      )) as Array<{ id: string }>;
      deleted += rows.length;
      if (rows.length < limit) {
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
  if (typeof value !== 'object' || value === null) {
    throw new Error('Outbox payload is not an object');
  }
  const envelope = value as Record<string, unknown>;
  for (const key of ['eventId', 'eventType', 'aggregateId', 'correlationId', 'occurredAt']) {
    if (typeof envelope[key] !== 'string') {
      throw new Error(`Outbox payload is missing ${key}`);
    }
  }
  if (typeof envelope.version !== 'number' || !('data' in envelope)) {
    throw new Error('Outbox payload has an invalid version or data');
  }
  return envelope as IntegrationEnvelope<unknown>;
}
