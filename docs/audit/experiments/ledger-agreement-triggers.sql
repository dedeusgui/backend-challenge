-- Experiment: ledger agreement triggers (ARCHITECTURE 6.2). NOT part of the migrations.
--
-- Measured and rejected from the write path: docs/audit/PERFORMANCE_COMPARISON.md, experiment 1.
-- Applied only by test/experiments/ledger-agreement-triggers.test.ts and test/perf/ledger-trigger-cost.ts,
-- on a fresh test database, after every migration.
--
-- Two constraint triggers, deferred to COMMIT, refuse a commit in which a wallet's balance does not equal
-- its last ledger entry, or in which a ledger entry does not continue the chain of its wallet or does not
-- end at the wallet's balance.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM wallets w
     WHERE w.balance IS DISTINCT FROM COALESCE(
       (SELECT l.balance_after FROM wallet_ledger_entries l
         WHERE l.wallet_id = w.id ORDER BY l.seq DESC LIMIT 1), 0)
  ) THEN
    RAISE EXCEPTION 'a wallet balance differs from its ledger' USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION wallet_ledger_entry_continues_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_after numeric(20,2);
  current_balance numeric(20,2);
BEGIN
  SELECT l.balance_after INTO previous_after
    FROM wallet_ledger_entries l
   WHERE l.wallet_id = NEW.wallet_id AND l.seq < NEW.seq
   ORDER BY l.seq DESC LIMIT 1;
  IF COALESCE(previous_after, 0) <> NEW.balance_before THEN
    RAISE EXCEPTION 'ledger entry % does not continue the chain of its wallet', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT w.balance INTO current_balance FROM wallets w WHERE w.id = NEW.wallet_id;
  IF current_balance IS DISTINCT FROM NEW.balance_after THEN
    RAISE EXCEPTION 'ledger entry % does not end at the balance of its wallet', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER wallet_ledger_entries_continue_chain
  AFTER INSERT ON wallet_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entry_continues_chain();

CREATE FUNCTION wallet_balance_is_its_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_after numeric(20,2);
BEGIN
  SELECT l.balance_after INTO last_after
    FROM wallet_ledger_entries l
   WHERE l.wallet_id = NEW.id
   ORDER BY l.seq DESC LIMIT 1;
  IF COALESCE(last_after, 0) <> NEW.balance THEN
    RAISE EXCEPTION 'wallet % changed its balance without its ledger entry', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER wallets_balance_is_its_ledger
  AFTER INSERT OR UPDATE OF balance ON wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION wallet_balance_is_its_ledger();
