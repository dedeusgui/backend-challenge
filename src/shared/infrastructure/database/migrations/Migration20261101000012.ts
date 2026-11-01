import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000012 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION assert_wallet_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        affected_wallet_id uuid;
        wallet_balance numeric(20, 2);
        ledger_balance numeric(20, 2);
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          affected_wallet_id := NEW.id;
        ELSE
          affected_wallet_id := NEW.wallet_id;
        END IF;

        SELECT balance INTO wallet_balance
          FROM wallets
         WHERE id = affected_wallet_id;

        SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0.00)
          INTO ledger_balance
          FROM wallet_ledger_entries
         WHERE wallet_id = affected_wallet_id;

        IF wallet_balance IS DISTINCT FROM ledger_balance THEN
          RAISE EXCEPTION 'wallet balance does not match its ledger'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_balance_check
        AFTER INSERT OR UPDATE OF balance ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_balance()
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_balance_check
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_balance()
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TRIGGER wallet_ledger_entries_balance_check ON wallet_ledger_entries`);
    this.addSql(`DROP TRIGGER wallets_ledger_balance_check ON wallets`);
    this.addSql(`DROP FUNCTION assert_wallet_ledger_balance()`);
  }
}
