import { Migration } from '@mikro-orm/migrations';

/**
 * A read model of the wallet and its ledger, computed in the database: for each wallet, the stored balance, the
 * balance the ledger sums to, the number of entries, and their difference. Reconciliation computes the same
 * figures in the application (WalletQueries.reconcile). The view does not feed any decision. Its use is to be
 * queried by an operator, and to be compared with the application in test/integration/schema/wallet-ledger-summary.test.ts,
 * so that two implementations of the same rule must agree.
 *
 * A plain view, not a materialized one: a materialized view would show a balance that is older than the last
 * commit, which is wrong for a figure whose purpose is to check the balance.
 */
export class Migration20261101000011 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE VIEW wallet_ledger_summary AS
      SELECT w.id AS wallet_id,
             w.currency,
             w.balance AS stored_balance,
             COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0.00) AS calculated_balance,
             w.balance - COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0.00) AS difference,
             COUNT(l.id) AS entries
        FROM wallets w
        LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       GROUP BY w.id, w.currency, w.balance
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP VIEW wallet_ledger_summary`);
  }
}
