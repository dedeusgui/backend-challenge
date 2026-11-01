import type { TestDatabase } from './test-database';

/**
 * Moves the held references' schedule forward by `ms` on the database clock: each PENDING_REFERENCE transaction's
 * next lookup moves back by `ms`, so it is due now. The database's now() does not move during a test.
 */
export async function advanceReferenceClock(database: TestDatabase, ms: number): Promise<void> {
  await database.orm.em.getConnection().execute(
    `UPDATE wager_transactions
        SET reference_next_attempt_at = reference_next_attempt_at - make_interval(secs => ?)
      WHERE status = 'PENDING_REFERENCE'`,
    [ms / 1000],
  );
}
