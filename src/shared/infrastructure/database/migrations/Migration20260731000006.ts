import { Migration } from '@mikro-orm/migrations';

/**
 * A WIN and a LOSS may omit the reference of the BET they settle. The specification (challenge 6.3
 * and 7) requires a reference only for REFUND and ROLLBACK, and makes the WIN's reference optional
 * ("pode referenciar"). Migration 3 required it, which narrowed the specification.
 *
 * With the reference, the one-result rule still holds: a BET has at most one PROCESSED result
 * (`wager_one_processed_result_per_reference`). Without it, the database cannot tie the result to
 * a BET, and that rule does not apply to it. The domain states the same reading (ARCHITECTURE
 * section 13).
 *
 * The down migration restores the required shape, so it fails while a WIN or a LOSS without a
 * reference is stored.
 */
export class Migration20260731000006 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_shape,
        ADD CONSTRAINT wager_reference_shape CHECK (
          (kind IN ('REFUND', 'ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR kind IN ('WIN', 'LOSS')
          OR (kind IN ('BET', 'OPENING') AND reference_external_transaction_id IS NULL)
        )
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_shape,
        ADD CONSTRAINT wager_reference_shape CHECK (
          (kind IN ('REFUND', 'ROLLBACK', 'WIN', 'LOSS') AND reference_external_transaction_id IS NOT NULL)
          OR (kind IN ('BET', 'OPENING') AND reference_external_transaction_id IS NULL)
        )
    `);
  }
}
