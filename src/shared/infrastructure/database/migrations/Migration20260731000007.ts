import { Migration } from '@mikro-orm/migrations';

/**
 * A transaction held for its reference stores the balance observed when it was held. A replay of
 * the same request returns that balance (ARCHITECTURE section 6), so it cannot change when the
 * wallet does. The earlier status shape allowed no balance before a transaction was decided.
 *
 * A PENDING_REFERENCE must now carry that balance, and PENDING must carry none. PENDING is never
 * committed, so the database still refuses it with a balance.
 *
 * The down migration restores the earlier shape, so it fails while a held transaction has its
 * balance stored.
 */
export class Migration20260731000007 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_status_shape,
        ADD CONSTRAINT wager_status_shape CHECK (
          (status = 'PROCESSED' AND processed_at IS NOT NULL AND resulting_balance IS NOT NULL
             AND failure_code IS NULL)
          OR (status = 'REJECTED' AND failure_code IS NOT NULL AND processed_at IS NULL)
          OR (status = 'FAILED' AND failure_code IS NOT NULL AND processed_at IS NULL)
          OR (status = 'PENDING_REFERENCE' AND failure_code IS NULL AND processed_at IS NULL
             AND resulting_balance IS NOT NULL)
          OR (status = 'PENDING' AND failure_code IS NULL AND processed_at IS NULL
             AND resulting_balance IS NULL)
        )
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_status_shape,
        ADD CONSTRAINT wager_status_shape CHECK (
          (status = 'PROCESSED' AND processed_at IS NOT NULL AND resulting_balance IS NOT NULL
             AND failure_code IS NULL)
          OR (status = 'REJECTED' AND failure_code IS NOT NULL AND processed_at IS NULL)
          OR (status = 'FAILED' AND failure_code IS NOT NULL AND processed_at IS NULL)
          OR (status IN ('PENDING', 'PENDING_REFERENCE') AND failure_code IS NULL
             AND processed_at IS NULL AND resulting_balance IS NULL)
        )
    `);
  }
}
