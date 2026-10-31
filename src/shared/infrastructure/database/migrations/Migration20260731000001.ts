import { Migration } from '@mikro-orm/migrations';

/**
 * Schedule for transactions waiting on a reference. Attempts and the next lookup time
 * are stored in the row, so a restarted worker resumes the schedule instead of starting over.
 */
export class Migration20260731000001 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        ADD COLUMN reference_next_attempt_at timestamptz NULL,
        ADD CONSTRAINT wager_pending_reference_schedule CHECK (
          status <> 'PENDING_REFERENCE' OR reference_next_attempt_at IS NOT NULL
        )
    `);
    // Serves the reference worker's scan of held transactions that are due.
    this.addSql(`
      CREATE INDEX wager_pending_reference_due_idx ON wager_transactions (reference_next_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS wager_pending_reference_due_idx`);
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT IF EXISTS wager_pending_reference_schedule,
        DROP COLUMN IF EXISTS reference_next_attempt_at,
        DROP COLUMN IF EXISTS reference_attempts
    `);
  }
}
