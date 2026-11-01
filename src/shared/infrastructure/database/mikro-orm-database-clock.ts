import type { EntityManager } from '@mikro-orm/postgresql';
import type { DatabaseClock } from '../../application/ports/database-clock';

/**
 * Reads now() on the unit of work's own transaction, so every read in one unit of work gives the same instant.
 * The query runs on `em.execute`, which joins the transaction, and not on the bare connection, which does not.
 */
export class MikroOrmDatabaseClock implements DatabaseClock {
  constructor(private readonly em: EntityManager) {}

  async now(): Promise<Date> {
    const rows: unknown = await this.em.execute(
      `SELECT floor(extract(epoch FROM now()) * 1000)::text AS ms`,
    );
    return new Date(Number(millisecondsFrom(rows)));
  }
}

function millisecondsFrom(rows: unknown): string {
  const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
  if (
    typeof first === 'object' &&
    first !== null &&
    'ms' in first &&
    typeof first.ms === 'string'
  ) {
    return first.ms;
  }
  throw new Error('the database returned no clock reading');
}
