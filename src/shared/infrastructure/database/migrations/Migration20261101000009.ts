import { Migration } from '@mikro-orm/migrations';

/**
 * An outbox payload is an integration envelope that the publisher reads back with the same checks
 * (see MikroOrmOutboxStore). Before this constraint, a payload that failed those checks was accepted
 * on write and then stopped the whole claim on every pass, so no event was published while it stayed
 * due. The database now refuses the row inside the financial transaction that would have written it,
 * which fails the request loudly instead of halting publication later.
 *
 * Each check uses IS NOT DISTINCT FROM rather than =: a missing key yields NULL, and a CHECK that
 * evaluates to NULL passes, so `=` would accept a payload without the key.
 *
 * The migration fails, and changes nothing, when a stored row already violates the shape. Such a row
 * must be inspected and corrected before the migration runs again.
 */
export class Migration20261101000009 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE outbox_messages ADD CONSTRAINT outbox_envelope_shape CHECK (
        jsonb_typeof(payload) IS NOT DISTINCT FROM 'object'
        AND jsonb_typeof(payload -> 'eventId') IS NOT DISTINCT FROM 'string'
        AND jsonb_typeof(payload -> 'eventType') IS NOT DISTINCT FROM 'string'
        AND jsonb_typeof(payload -> 'aggregateId') IS NOT DISTINCT FROM 'string'
        AND jsonb_typeof(payload -> 'correlationId') IS NOT DISTINCT FROM 'string'
        AND jsonb_typeof(payload -> 'occurredAt') IS NOT DISTINCT FROM 'string'
        AND jsonb_typeof(payload -> 'version') IS NOT DISTINCT FROM 'number'
        AND payload ? 'data'
      )
    `);
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE outbox_messages DROP CONSTRAINT outbox_envelope_shape`);
  }
}
