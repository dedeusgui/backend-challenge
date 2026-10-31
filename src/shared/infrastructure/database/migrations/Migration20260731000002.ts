import { Migration } from '@mikro-orm/migrations';

/**
 * A referenced transaction is reversed at most once, whatever the kind of reversal. The earlier
 * index allowed one REFUND and one ROLLBACK of the same BET, which credits the stake twice.
 *
 * A WIN may also name the BET it settles (optional reference), so the reference-shape check must
 * allow it. The earlier check refused every WIN that carried a reference.
 */
export class Migration20260731000002 extends Migration {
  async up(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS wager_one_processed_reversal_per_kind`);
    this.addSql(`
      CREATE UNIQUE INDEX wager_one_processed_reversal_per_reference
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
    `);
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_shape,
        ADD CONSTRAINT wager_reference_shape CHECK (
          (kind IN ('REFUND', 'ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR kind = 'WIN'
          OR (kind IN ('BET', 'OPENING', 'LOSS') AND reference_external_transaction_id IS NULL)
        )
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_shape,
        ADD CONSTRAINT wager_reference_shape CHECK (
          (kind IN ('REFUND', 'ROLLBACK')) = (reference_external_transaction_id IS NOT NULL)
          AND (kind NOT IN ('BET', 'OPENING', 'LOSS') OR reference_external_transaction_id IS NULL)
        )
    `);
    this.addSql(`DROP INDEX IF EXISTS wager_one_processed_reversal_per_reference`);
    this.addSql(`
      CREATE UNIQUE INDEX wager_one_processed_reversal_per_kind
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
    `);
  }
}
