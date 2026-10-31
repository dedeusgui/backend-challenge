import { Migration } from '@mikro-orm/migrations';

/**
 * API clients. A PROVIDER key names one provider, and an OPERATOR key names none. The table holds
 * the SHA-256 hash of each key, never the key. A revoked client keeps its row, so an audit can
 * still see it.
 */
export class Migration20260731000004 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE api_clients (
        id uuid PRIMARY KEY,
        name text NOT NULL CHECK (length(btrim(name)) > 0),
        role text NOT NULL CHECK (role IN ('PROVIDER', 'OPERATOR')),
        provider_id text NULL CHECK (provider_id IS NULL OR length(btrim(provider_id)) > 0),
        key_hash char(64) NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
        created_at timestamptz NOT NULL,
        revoked_at timestamptz NULL,
        CONSTRAINT api_client_role_shape CHECK (
          (role = 'PROVIDER' AND provider_id IS NOT NULL)
          OR (role = 'OPERATOR' AND provider_id IS NULL)
        )
      )
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE api_clients`);
  }
}
