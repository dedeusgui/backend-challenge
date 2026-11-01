import type { MikroORM } from '@mikro-orm/postgresql';
import type { IntegrationEnvelope } from '../../../shared/domain/integration-event';
import { OutboxMessage, retryDelayMs } from '../domain/outbox-message';
import type { ClaimRequest, OutboxStore } from '../application/outbox-store.port';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
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
               AND next_attempt_at <= now()
               AND (lease_expires_at IS NULL OR lease_expires_at < now())
             ORDER BY next_attempt_at, occurred_at
             LIMIT ?
             FOR UPDATE SKIP LOCKED)
         RETURNING id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
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
          SET published_at = ?, lease_token = NULL, lease_expires_at = NULL
        WHERE lease_token = ? AND id IN (${placeholders})
       RETURNING id`,
      [at, token, ...messages.map((message) => message.id)],
    )) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  async reschedule(message: OutboxMessage, token: string): Promise<boolean> {
    const rows = (await this.orm.em.getConnection().execute(
      `UPDATE outbox_messages
          SET attempts = ?, next_attempt_at = now() + make_interval(secs => ?),
              lease_token = NULL, lease_expires_at = NULL
        WHERE id = ? AND lease_token = ?
       RETURNING id`,
      [message.attempts, retryDelayMs(message.attempts) / 1000, message.id, token],
    )) as Array<{ id: string }>;
    return rows.length === 1;
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
