import { Migration } from '@mikro-orm/migrations';

/**
 * Row guards, checked when a row is updated. Each guard reads the row being changed and nothing else, so it
 * adds no lookup inside the wallet lock (contrast with the cross-row ledger checks, which were measured and
 * not adopted: docs/audit/PERFORMANCE_COMPARISON.md, experiment 1).
 *
 * 1. wager_transactions: the identity and the payload of a transaction never change. A status changes only
 *    along the lifecycle table of src/modules/wagering/domain/wager-lifecycle.ts, which this function copies.
 *    A terminal transaction (PROCESSED, REJECTED, FAILED) does not change at all. The reference attempt count
 *    only grows.
 * 2. wallets: the identity, the player, the currency and the creation time never change. The version moves
 *    exactly when the balance moves, and by one (challenge 6.2).
 *
 * The status list below must equal STATUS_TRANSITIONS. test/integration/schema/row-guards.test.ts checks
 * every pair of statuses against that table, so a drift in either place fails the suite.
 */
export class Migration20261101000010 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION wager_transaction_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
           OR NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id
           OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
           OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
           OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
           OR NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.round_id IS DISTINCT FROM OLD.round_id
           OR NEW.game_id IS DISTINCT FROM OLD.game_id
           OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.amount IS DISTINCT FROM OLD.amount
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'the identity and the payload of a transaction never change'
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.reference_attempts < OLD.reference_attempts THEN
          RAISE EXCEPTION 'the reference attempt count only grows' USING ERRCODE = 'check_violation';
        END IF;

        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'a terminal transaction does not change' USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END IF;

        IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
             (OLD.status = 'PENDING' AND NEW.status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
          OR (OLD.status = 'PENDING_REFERENCE' AND NEW.status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
        ) THEN
          RAISE EXCEPTION 'a status change is not allowed by the lifecycle' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_row_guard
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transaction_row_guard()
    `);

    this.addSql(`
      CREATE FUNCTION wallet_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'the identity, player, currency and creation of a wallet never change'
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.balance IS DISTINCT FROM OLD.balance THEN
          IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
            RAISE EXCEPTION 'a balance change bumps the version by exactly one'
              USING ERRCODE = 'check_violation';
          END IF;
        ELSIF NEW.version IS DISTINCT FROM OLD.version THEN
          RAISE EXCEPTION 'the version changes only together with the balance'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$
    `);
    this.addSql(`
      CREATE TRIGGER wallets_row_guard
        BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallet_row_guard()
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TRIGGER wallets_row_guard ON wallets`);
    this.addSql(`DROP FUNCTION wallet_row_guard()`);
    this.addSql(`DROP TRIGGER wager_transactions_row_guard ON wager_transactions`);
    this.addSql(`DROP FUNCTION wager_transaction_row_guard()`);
  }
}
