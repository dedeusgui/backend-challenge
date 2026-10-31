import { Migration } from '@mikro-orm/migrations';

/**
 * Initial financial schema. Invariants live here, not only in application code:
 * - wallets: one per player and currency, non-negative balance, version >= 1.
 * - wallet_ledger_entries: append-only (UPDATE, DELETE and TRUNCATE are refused),
 *   one entry per wallet and transaction, and arithmetic that must balance.
 * - wager_transactions: idempotency and external identity are unique per provider;
 *   kind and status shapes are checked; a reference must belong to the same
 *   provider and wallet; each reference can be reversed once per kind.
 * - inbox_messages: deduplication by (consumer_name, message_id).
 * - outbox_messages: one row per stable event id, indexed for the pending scan.
 */
export class Migration20260731000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id text NOT NULL,
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) NOT NULL CHECK (balance >= 0),
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency)
      )
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id uuid NOT NULL REFERENCES wallets (id),
        player_id text NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20,2) NOT NULL CHECK (amount >= 0),
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text NULL,
        reference_transaction_id uuid NULL,
        status text NOT NULL CHECK (
          status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        failure_code text NULL,
        resulting_balance numeric(20,2) NULL CHECK (resulting_balance >= 0),
        processed_at timestamptz NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT wager_external_identity_key UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_idempotency_key UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_reference_target_key UNIQUE (id, provider_id, wallet_id),
        CONSTRAINT wager_reference_wallet_key UNIQUE (id, wallet_id),
        CONSTRAINT wager_reference_fk FOREIGN KEY (reference_transaction_id, provider_id, wallet_id)
          REFERENCES wager_transactions (id, provider_id, wallet_id),
        CONSTRAINT wager_reference_shape CHECK (
          (kind IN ('REFUND', 'ROLLBACK')) = (reference_external_transaction_id IS NOT NULL)
          AND (kind NOT IN ('BET', 'OPENING', 'LOSS') OR reference_external_transaction_id IS NULL)
        ),
        CONSTRAINT wager_resolved_reference_shape CHECK (
          reference_transaction_id IS NULL
          OR reference_external_transaction_id IS NOT NULL
        ),
        CONSTRAINT wager_status_shape CHECK (
          (status = 'PROCESSED' AND processed_at IS NOT NULL AND resulting_balance IS NOT NULL
             AND failure_code IS NULL)
          OR (status = 'REJECTED' AND failure_code IS NOT NULL AND processed_at IS NULL)
          OR (status = 'FAILED' AND failure_code IS NOT NULL AND processed_at IS NULL)
          OR (status IN ('PENDING', 'PENDING_REFERENCE') AND failure_code IS NULL
             AND processed_at IS NULL AND resulting_balance IS NULL)
        ),
        CONSTRAINT wager_processed_reversal_is_resolved CHECK (
          status <> 'PROCESSED' OR kind NOT IN ('REFUND', 'ROLLBACK')
          OR reference_transaction_id IS NOT NULL
        )
      )
    `);
    // Serves reference resolution by (provider, externalTransactionId): covered by wager_external_identity_key.
    // Serves the "one reversal per reference and kind" rule, with PROCESSED reversals only.
    this.addSql(`
      CREATE UNIQUE INDEX wager_one_processed_reversal_per_kind
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        seq bigint GENERATED ALWAYS AS IDENTITY,
        wallet_id uuid NOT NULL REFERENCES wallets (id),
        transaction_id uuid NOT NULL,
        direction text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        amount numeric(20,2) NOT NULL CHECK (amount > 0),
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL,
        CONSTRAINT ledger_seq_key UNIQUE (seq),
        CONSTRAINT ledger_one_entry_per_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_transaction_in_same_wallet_fk FOREIGN KEY (transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      )
    `);
    // Serves the ledger listing for one wallet in sequence order (cursor pagination).
    this.addSql(`CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq)`);

    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_refuse_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only';
      END;
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_update_or_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_refuse_mutation()
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_refuse_mutation()
    `);

    // Inbox: the primary key is the deduplication identity (consumer_name, message_id).
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);

    // Outbox: id is the stable event id. The partial index serves the scan of
    // unpublished rows that are due, which is the publisher's only query.
    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id text NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        published_at timestamptz NULL,
        lease_token uuid NULL,
        lease_expires_at timestamptz NULL
      )
    `);
    this.addSql(`
      CREATE INDEX outbox_due_unpublished_idx ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_ledger_entries_refuse_mutation()`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
  }
}
