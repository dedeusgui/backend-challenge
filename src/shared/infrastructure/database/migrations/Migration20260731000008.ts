import { Migration } from '@mikro-orm/migrations';

/**
 * Two rules the domain already enforces, which the database did not.
 *
 * 1. A REJECTED or FAILED transaction stores the balance observed when it was decided. A replay
 *    returns that balance, so a row without one could only be answered with an error.
 * 2. A BET settles once, and a refund and a result cannot both be processed for it, in either
 *    order (REFERENCE_ALREADY_SETTLED and REFERENCE_ALREADY_REVERSED). The unique index covered
 *    only WIN and LOSS, so a refund processed before a win was refused by the domain alone. A
 *    rollback stays outside the index: it applies after a result, by design (ARCHITECTURE 13).
 *
 * The down migration restores the earlier rules. It fails while a refund and a result coexist.
 */
export class Migration20260731000008 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_status_shape,
        ADD CONSTRAINT wager_status_shape CHECK (
          (status = 'PROCESSED' AND processed_at IS NOT NULL AND resulting_balance IS NOT NULL
             AND failure_code IS NULL)
          OR (status IN ('REJECTED', 'FAILED') AND failure_code IS NOT NULL AND processed_at IS NULL
             AND resulting_balance IS NOT NULL)
          OR (status = 'PENDING_REFERENCE' AND failure_code IS NULL AND processed_at IS NULL
             AND resulting_balance IS NOT NULL)
          OR (status = 'PENDING' AND failure_code IS NULL AND processed_at IS NULL
             AND resulting_balance IS NULL)
        )
    `);
    this.addSql(`DROP INDEX wager_one_processed_result_per_reference`);
    this.addSql(`
      CREATE UNIQUE INDEX wager_one_processed_settlement_per_reference
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('WIN', 'LOSS', 'REFUND')
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX wager_one_processed_settlement_per_reference`);
    this.addSql(`
      CREATE UNIQUE INDEX wager_one_processed_result_per_reference
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('WIN', 'LOSS')
    `);
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
}
