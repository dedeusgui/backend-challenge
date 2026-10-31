/**
 * The duplicate audit that closes a load step: a count of transactions the committed state would show twice.
 * It is pure SQL text, so the runner and the integration test run the same statement.
 */

/** The tables the audit reads: the transactions of the API and its ledger. */
export interface AuditTables {
  readonly transactions: string;
  readonly ledger: string;
}

/** The tables of the schema the API writes. */
export const PRODUCTION_TABLES: AuditTables = {
  transactions: 'wager_transactions',
  ledger: 'wallet_ledger_entries',
};

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Counts, in one number:
 * - transactions that share an identity under one provider, (provider_id, external_transaction_id). Two
 *   providers that use the same external id are two transactions, and are not counted;
 * - transactions that share an idempotency key under one provider, (provider_id, idempotency_key);
 * - transactions with more than one ledger entry: their effect was applied more than once.
 * Zero means every operation has one identity and one effect.
 */
export function duplicateAuditSql(tables: AuditTables): string {
  for (const name of [tables.transactions, tables.ledger]) {
    if (!TABLE_NAME.test(name)) throw new Error(`not a table name: ${name}`);
  }
  const { transactions: t, ledger: l } = tables;
  return `SELECT (
      (SELECT count(*) FROM (SELECT 1 FROM ${t} GROUP BY provider_id, external_transaction_id HAVING count(*) > 1) identities)
    + (SELECT count(*) FROM (SELECT 1 FROM ${t} GROUP BY provider_id, idempotency_key HAVING count(*) > 1) keys)
    + (SELECT count(*) FROM (SELECT 1 FROM ${l} GROUP BY transaction_id HAVING count(*) > 1) applied)
  )::text AS duplicates`;
}
