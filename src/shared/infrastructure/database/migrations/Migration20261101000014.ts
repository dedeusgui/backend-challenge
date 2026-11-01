import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000014 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE wager_transactions ADD CONSTRAINT wager_reference_external_target_key UNIQUE (id, provider_id, wallet_id, external_transaction_id)`,
    );
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_fk`);
    this.addSql(
      `ALTER TABLE wager_transactions ADD CONSTRAINT wager_reference_fk FOREIGN KEY (reference_transaction_id, provider_id, wallet_id, reference_external_transaction_id) REFERENCES wager_transactions (id, provider_id, wallet_id, external_transaction_id)`,
    );
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_fk`);
    this.addSql(
      `ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_external_target_key`,
    );
    this.addSql(
      `ALTER TABLE wager_transactions ADD CONSTRAINT wager_reference_fk FOREIGN KEY (reference_transaction_id, provider_id, wallet_id) REFERENCES wager_transactions (id, provider_id, wallet_id)`,
    );
  }
}
