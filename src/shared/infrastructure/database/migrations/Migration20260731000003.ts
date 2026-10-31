import { Migration } from '@mikro-orm/migrations';

/**
 * A result names the BET it settles, and a BET has at most one PROCESSED result. Before this
 * migration a WIN could omit its reference, so no result could be tied to its BET, and two WINs
 * on one BET were both credited.
 *
 * The down migration fails when a LOSS already references a BET, because the previous shape does
 * not allow that. Roll back only before results have been recorded.
 */
export class Migration20260731000003 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_shape,
        ADD CONSTRAINT wager_reference_shape CHECK (
          (kind IN ('REFUND', 'ROLLBACK', 'WIN', 'LOSS') AND reference_external_transaction_id IS NOT NULL)
          OR (kind IN ('BET', 'OPENING') AND reference_external_transaction_id IS NULL)
        )
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_one_processed_result_per_reference
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('WIN', 'LOSS')
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS wager_one_processed_result_per_reference`);
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_shape,
        ADD CONSTRAINT wager_reference_shape CHECK (
          (kind IN ('REFUND', 'ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR kind = 'WIN'
          OR (kind IN ('BET', 'OPENING', 'LOSS') AND reference_external_transaction_id IS NULL)
        )
    `);
  }
}
