import { Migration } from '@mikro-orm/migrations';

export class Migration20261102000016 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM (
              SELECT balance_before,
                     LAG(balance_after, 1, 0.00::numeric(20, 2))
                       OVER (PARTITION BY wallet_id ORDER BY seq) AS previous_after
                FROM wallet_ledger_entries
            ) chain
           WHERE balance_before IS DISTINCT FROM previous_after
        ) THEN
          RAISE EXCEPTION 'wallet ledger contains a broken balance chain'
            USING ERRCODE = 'check_violation';
        END IF;
      END $$
    `);
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entry_continues_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous_after numeric(20, 2);
      BEGIN
        SELECT balance_after INTO previous_after
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id AND seq < NEW.seq
         ORDER BY seq DESC
         LIMIT 1;

        IF COALESCE(previous_after, 0.00) <> NEW.balance_before THEN
          RAISE EXCEPTION 'ledger entry % does not continue the balance chain', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_continue_chain
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entry_continues_chain()
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TRIGGER wallet_ledger_entries_continue_chain ON wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION wallet_ledger_entry_continues_chain()`);
  }
}
