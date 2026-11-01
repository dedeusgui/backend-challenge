import type { TestDatabase } from './test-database';

/**
 * Advances the outbox's notion of time by `ms`. The database's now() does not move during a test, so the stored
 * instants of every unpublished row are moved back by `ms` instead: a row due in 500 ms becomes due now, and a lease
 * that expires in 30 s expires now. That is the same change in what the rows say about the database clock.
 * A negative `ms` moves the rows the other way, so a row whose backoff has not ended stays not yet due, however
 * long the test takes in real time.
 */
export async function advanceOutboxClock(database: TestDatabase, ms: number): Promise<void> {
  const seconds = ms / 1000;
  await database.orm.em.getConnection().execute(
    `UPDATE outbox_messages
        SET next_attempt_at = next_attempt_at - make_interval(secs => ?),
            lease_expires_at = lease_expires_at - make_interval(secs => ?)
      WHERE published_at IS NULL`,
    [seconds, seconds],
  );
}
