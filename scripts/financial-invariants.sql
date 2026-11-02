-- Database-side checks for docs/INVARIANT_REVIEW.md.
-- The caller must execute this in a read-only transaction and treat any SQL error as failure.
-- Application-only guarantees (for example, the absence of a process-wide lock) remain covered by
-- code review and integration tests; these queries check their database-visible prerequisites.
DO $financial_invariants$
DECLARE
  violation_count bigint;
  violations text[] := ARRAY[]::text[];
  migration_count bigint;
BEGIN
  -- INV-01: persisted transaction and ledger identities are unique.
  SELECT COUNT(*) INTO violation_count FROM (
    SELECT 1 FROM wager_transactions GROUP BY provider_id, external_transaction_id HAVING COUNT(*) > 1
    UNION ALL
    SELECT 1 FROM wager_transactions GROUP BY provider_id, idempotency_key HAVING COUNT(*) > 1
    UNION ALL
    SELECT 1 FROM wallet_ledger_entries GROUP BY wallet_id, transaction_id HAVING COUNT(*) > 1
    UNION ALL
    SELECT 1 FROM wager_transactions
      WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'WIN', 'LOSS')
      GROUP BY reference_transaction_id HAVING COUNT(*) > 1
    UNION ALL
    SELECT 1 FROM wager_transactions
      WHERE status = 'PROCESSED' AND kind = 'ROLLBACK'
      GROUP BY reference_transaction_id HAVING COUNT(*) > 1
  ) AS duplicate_identities;
  RAISE NOTICE 'INV-01 violations=%', violation_count;
  IF violation_count <> 0 THEN violations := array_append(violations, 'INV-01'); END IF;

  -- INV-02: the ledger is arithmetically continuous and reconstructs each materialized balance.
  WITH ledger_chain AS (
    SELECT wallet_id,
           seq,
           balance_before,
           balance_after,
           LAG(balance_after, 1, 0::numeric) OVER (PARTITION BY wallet_id ORDER BY seq) AS prior_balance
      FROM wallet_ledger_entries
  ), ledger_totals AS (
    SELECT wallet_id,
           SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) AS net_amount,
           (array_agg(balance_after ORDER BY seq DESC))[1] AS last_balance
      FROM wallet_ledger_entries
     GROUP BY wallet_id
  )
  SELECT COUNT(*) INTO violation_count FROM (
    SELECT id FROM wallets w
      LEFT JOIN ledger_totals l ON l.wallet_id = w.id
     WHERE w.balance <> COALESCE(l.net_amount, 0::numeric)
        OR w.balance <> COALESCE(l.last_balance, 0::numeric)
    UNION ALL
    SELECT wallet_id FROM ledger_chain WHERE balance_before <> prior_balance
  ) AS broken_ledger;
  RAISE NOTICE 'INV-02 violations=%', violation_count;
  IF violation_count <> 0 THEN violations := array_append(violations, 'INV-02'); END IF;

  -- INV-03: persisted monetary columns use the exact NUMERIC(20,2) representation.
  WITH expected(table_name, column_name) AS (
    VALUES ('wallets', 'balance'),
           ('wager_transactions', 'amount'),
           ('wager_transactions', 'resulting_balance'),
           ('wallet_ledger_entries', 'amount'),
           ('wallet_ledger_entries', 'balance_before'),
           ('wallet_ledger_entries', 'balance_after')
  )
  SELECT COUNT(*) INTO violation_count
    FROM expected e
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public' AND c.table_name = e.table_name AND c.column_name = e.column_name
   WHERE c.column_name IS NULL
      OR c.data_type <> 'numeric'
      OR c.numeric_precision <> 20
      OR c.numeric_scale <> 2;
  RAISE NOTICE 'INV-03 violations=%', violation_count;
  IF violation_count <> 0 THEN violations := array_append(violations, 'INV-03'); END IF;

  -- INV-04: the persistent idempotency key is backed by a validated unique constraint.
  SELECT COUNT(*) INTO violation_count
    FROM (VALUES ('wager_idempotency_key')) AS expected(constraint_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = 'public.wager_transactions'::regclass
        AND c.conname = expected.constraint_name AND c.contype = 'u' AND c.convalidated
   );
  RAISE NOTICE 'INV-04 violations=%', violation_count;
  IF violation_count <> 0 THEN violations := array_append(violations, 'INV-04'); END IF;

  -- INV-05: committed outbox rows have a coherent delivery state and timestamp.
  SELECT COUNT(*) INTO violation_count
    FROM outbox_messages
   WHERE (status = 'PUBLISHED') IS DISTINCT FROM (published_at IS NOT NULL);
  RAISE NOTICE 'INV-05 violations=%', violation_count;
  IF violation_count <> 0 THEN violations := array_append(violations, 'INV-05'); END IF;

  -- INV-06: ledger mutation guards exist and are enabled for ordinary sessions.
  WITH expected(table_name, trigger_name) AS (
    VALUES ('wallet_ledger_entries', 'wallet_ledger_entries_no_update_or_delete'),
           ('wallet_ledger_entries', 'wallet_ledger_entries_no_truncate')
  )
  SELECT COUNT(*) INTO violation_count
    FROM expected e
    LEFT JOIN pg_trigger t
      ON t.tgrelid = format('public.%I', e.table_name)::regclass
     AND t.tgname = e.trigger_name
     AND NOT t.tgisinternal
     AND t.tgenabled = 'O'
   WHERE t.oid IS NULL;
  IF to_regprocedure('public.wallet_ledger_entries_refuse_mutation()') IS NULL THEN
    violation_count := violation_count + 1;
  END IF;
  RAISE NOTICE 'INV-06 violations=%', violation_count;
  IF violation_count <> 0 THEN violations := array_append(violations, 'INV-06'); END IF;

  -- INV-07: wallet identity is scoped by player and currency, with no duplicate stored wallets.
  SELECT COUNT(*) INTO violation_count FROM (
    SELECT 1 FROM wallets GROUP BY player_id, currency HAVING COUNT(*) > 1
  ) AS duplicate_wallets;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.wallets'::regclass
       AND c.conname = 'wallets_player_currency_key' AND c.contype = 'u' AND c.convalidated
  ) THEN
    violation_count := violation_count + 1;
  END IF;
  RAISE NOTICE 'INV-07 violations=%', violation_count;
  IF violation_count <> 0 THEN violations := array_append(violations, 'INV-07'); END IF;

  -- INV-08: wallet versions remain valid and the database guard enforces balance/version coupling.
  SELECT COUNT(*) INTO violation_count FROM wallets WHERE version < 1;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.wallets'::regclass AND t.tgname = 'wallets_row_guard'
       AND NOT t.tgisinternal AND t.tgenabled = 'O'
  ) OR to_regprocedure('public.wallet_row_guard()') IS NULL THEN
    violation_count := violation_count + 1;
  END IF;
  RAISE NOTICE 'INV-08 violations=%', violation_count;
  IF violation_count <> 0 THEN violations := array_append(violations, 'INV-08'); END IF;

  -- INV-09: resolved references still point to the same provider, wallet, round and external ID.
  SELECT COUNT(*) INTO violation_count
    FROM wager_transactions source
   WHERE source.reference_transaction_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM wager_transactions target
        WHERE target.id = source.reference_transaction_id
          AND target.provider_id = source.provider_id
          AND target.wallet_id = source.wallet_id
          AND target.round_id = source.round_id
          AND target.external_transaction_id = source.reference_external_transaction_id
     );
  RAISE NOTICE 'INV-09 violations=%', violation_count;
  IF violation_count <> 0 THEN violations := array_append(violations, 'INV-09'); END IF;

  -- INV-10: the database's core financial and messaging constraints are present and validated.
  WITH expected(table_name, constraint_name) AS (
    VALUES ('wallets', 'wallets_pkey'),
           ('wallets', 'wallets_balance_check'),
           ('wallets', 'wallets_currency_check'),
           ('wallets', 'wallets_version_check'),
           ('wallets', 'wallets_ledger_balance_check'),
           ('wager_transactions', 'wager_external_identity_key'),
           ('wager_transactions', 'wager_idempotency_key'),
           ('wager_transactions', 'wager_amount_shape'),
           ('wager_transactions', 'wager_status_shape'),
           ('wager_transactions', 'wager_reference_shape'),
           ('wager_transactions', 'wager_resolved_reference_shape'),
           ('wager_transactions', 'wager_processed_reversal_is_resolved'),
           ('wager_transactions', 'wager_reference_fk'),
           ('wallet_ledger_entries', 'ledger_one_entry_per_wallet_transaction'),
           ('wallet_ledger_entries', 'ledger_arithmetic'),
           ('wallet_ledger_entries', 'ledger_transaction_in_same_wallet_fk'),
           ('wallet_ledger_entries', 'ledger_wallet_currency_fk'),
           ('wallet_ledger_entries', 'wallet_ledger_entries_balance_check'),
           ('wallet_ledger_entries', 'wallet_ledger_entries_continue_chain'),
           ('outbox_messages', 'outbox_messages_pkey'),
           ('outbox_messages', 'outbox_envelope_shape'),
           ('outbox_messages', 'outbox_messages_status_check'),
           ('inbox_messages', 'inbox_messages_pkey')
  )
  SELECT COUNT(*) INTO violation_count
    FROM expected e
    LEFT JOIN pg_constraint c
      ON c.conrelid = format('public.%I', e.table_name)::regclass
     AND c.conname = e.constraint_name
     AND c.convalidated
   WHERE c.oid IS NULL;
  RAISE NOTICE 'INV-10 violations=%', violation_count;
  IF violation_count <> 0 THEN violations := array_append(violations, 'INV-10'); END IF;

  -- INV-11: wallet-row locking has a primary-key target and ledger rows are unique per wallet/transaction.
  SELECT COUNT(*) INTO violation_count FROM (
    SELECT 1 FROM wallet_ledger_entries GROUP BY wallet_id, transaction_id HAVING COUNT(*) > 1
  ) AS duplicate_ledger_rows;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.wallets'::regclass AND c.conname = 'wallets_pkey'
       AND c.contype = 'p' AND c.convalidated
  ) THEN
    violation_count := violation_count + 1;
  END IF;
  RAISE NOTICE 'INV-11 violations=%', violation_count;
  IF violation_count <> 0 THEN violations := array_append(violations, 'INV-11'); END IF;

  -- INV-12 is informational. 17 is the expected migration count after the current chain correction.
  SELECT COUNT(*) INTO migration_count FROM mikro_orm_migrations;
  RAISE NOTICE 'INV-12 migrations=% expected=% (informational)', migration_count, 17;

  IF cardinality(violations) > 0 THEN
    RAISE EXCEPTION 'financial invariant violations: %', array_to_string(violations, ', ')
      USING ERRCODE = 'check_violation';
  END IF;
END
$financial_invariants$;
