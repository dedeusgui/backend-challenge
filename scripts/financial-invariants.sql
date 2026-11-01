-- Financial invariants checked by SQL alone, outside the application code.
-- Read-only: the transaction is READ ONLY, so the script cannot change data.
-- Run after the migrations and any demonstration:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/financial-invariants.sql
-- Every row must show violations = 0 (INV-12 shows the number of applied migrations, expected 16).
-- Limit: a check that passes proves only the data it sees. The rules are also enforced by tests and constraints.
-- Independent financial invariants. Read-only: the session refuses writes.
\set ON_ERROR_STOP on
BEGIN READ ONLY;

SELECT 'INV-1 wallets with negative balance' AS check, count(*) AS violations
  FROM wallets WHERE balance < 0;

SELECT 'INV-2 wallet balance differs from the signed ledger sum' AS check, count(*) AS violations
  FROM wallets w
  LEFT JOIN (
    SELECT wallet_id,
           sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) AS signed_sum
      FROM wallet_ledger_entries GROUP BY wallet_id
  ) l ON l.wallet_id = w.id
  WHERE w.balance <> COALESCE(l.signed_sum, 0);

SELECT 'INV-3 ledger entry arithmetic (balance_after = balance_before +/- amount)' AS check, count(*) AS violations
  FROM wallet_ledger_entries
  WHERE balance_after <> CASE WHEN direction = 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END;

SELECT 'INV-4 ledger entries of a transaction that is not PROCESSED' AS check, count(*) AS violations
  FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id
  WHERE t.status <> 'PROCESSED';

SELECT 'INV-5 PROCESSED money movement without exactly one ledger entry' AS check, count(*) AS violations
  FROM wager_transactions t
  LEFT JOIN (SELECT transaction_id, count(*) AS n FROM wallet_ledger_entries GROUP BY transaction_id) e
    ON e.transaction_id = t.id
  WHERE t.status = 'PROCESSED' AND t.kind IN ('OPENING', 'BET', 'WIN', 'REFUND', 'ROLLBACK')
    AND COALESCE(e.n, 0) <> 1;

SELECT 'INV-6 LOSS with a ledger entry (LOSS must not move money)' AS check, count(*) AS violations
  FROM wager_transactions t JOIN wallet_ledger_entries e ON e.transaction_id = t.id
  WHERE t.kind = 'LOSS';

SELECT 'INV-7 a reference reversed more than once (REFUND or ROLLBACK, any kind)' AS check, count(*) AS violations
  FROM (
    SELECT reference_transaction_id FROM wager_transactions
     WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
     GROUP BY reference_transaction_id HAVING count(*) > 1
  ) d;

SELECT 'INV-8 a BET settled more than once (WIN or LOSS)' AS check, count(*) AS violations
  FROM (
    SELECT reference_transaction_id FROM wager_transactions
     WHERE status = 'PROCESSED' AND kind IN ('WIN', 'LOSS') AND reference_transaction_id IS NOT NULL
     GROUP BY reference_transaction_id HAVING count(*) > 1
  ) s;

SELECT 'INV-9 REFUND of a BET that also has a PROCESSED WIN or LOSS (D3)' AS check, count(*) AS violations
  FROM wager_transactions r
  WHERE r.status = 'PROCESSED' AND r.kind = 'REFUND'
    AND EXISTS (SELECT 1 FROM wager_transactions s
                 WHERE s.reference_transaction_id = r.reference_transaction_id
                   AND s.status = 'PROCESSED' AND s.kind IN ('WIN', 'LOSS'));

SELECT 'INV-10 REFUND or ROLLBACK amount differs from its reference (amount must match)' AS check, count(*) AS violations
  FROM wager_transactions r JOIN wager_transactions b ON b.id = r.reference_transaction_id
  WHERE r.status = 'PROCESSED' AND r.kind IN ('REFUND', 'ROLLBACK') AND r.amount <> b.amount;

SELECT 'INV-11 ROLLBACK direction is opposite to its reference (ledger)' AS check, count(*) AS violations
  FROM wager_transactions r
  JOIN wallet_ledger_entries re ON re.transaction_id = r.id
  JOIN wager_transactions b ON b.id = r.reference_transaction_id
  JOIN wallet_ledger_entries be ON be.transaction_id = b.id
  WHERE r.kind = 'ROLLBACK' AND r.status = 'PROCESSED' AND re.direction = be.direction;

SELECT 'INV-12 applied migrations (informational: expect 16)' AS check,
       count(*) AS violations
  FROM mikro_orm_migrations;

ROLLBACK;
