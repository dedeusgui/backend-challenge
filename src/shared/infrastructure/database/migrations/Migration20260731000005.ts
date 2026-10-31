import { Migration } from '@mikro-orm/migrations';

/**
 * The database enforces three rules that were checked only in the domain before:
 *
 * - an amount is positive, except a LOSS, which moves no balance and may be zero;
 * - a ledger entry has the currency of its wallet;
 * - a reference is a transaction of the same round.
 *
 * The player and the currency of a transaction are not tied to its wallet here. A rejected
 * transaction must keep the player and currency it was submitted with (ARCHITECTURE section 13),
 * so the domain checks them and the row is still written.
 *
 * The migration fails on a database that already holds rows breaking a rule. No such data exists
 * in this build, which has not been deployed.
 */
export class Migration20260731000005 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_amount_shape
        CHECK (amount > 0 OR (amount = 0 AND kind = 'LOSS'))
    `);
    this.addSql(`ALTER TABLE wallets ADD CONSTRAINT wallets_id_currency_key UNIQUE (id, currency)`);
    this.addSql(`
      ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ledger_wallet_currency_fk
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency)
    `);
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_reference_round_key
        UNIQUE (id, provider_id, wallet_id, round_id)
    `);
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_fk,
        ADD CONSTRAINT wager_reference_fk FOREIGN KEY (reference_transaction_id, provider_id, wallet_id, round_id)
          REFERENCES wager_transactions (id, provider_id, wallet_id, round_id)
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_fk,
        ADD CONSTRAINT wager_reference_fk FOREIGN KEY (reference_transaction_id, provider_id, wallet_id)
          REFERENCES wager_transactions (id, provider_id, wallet_id)
    `);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_round_key`);
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT ledger_wallet_currency_fk`);
    this.addSql(`ALTER TABLE wallets DROP CONSTRAINT wallets_id_currency_key`);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT wager_amount_shape`);
  }
}
