import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000013 extends Migration {
  async up(): Promise<void> {
    this.addSql(`ALTER TABLE outbox_messages ADD COLUMN status text NOT NULL DEFAULT 'PENDING'`);
    this.addSql(`UPDATE outbox_messages SET status = 'PUBLISHED' WHERE published_at IS NOT NULL`);
    this.addSql(
      `ALTER TABLE outbox_messages ADD CONSTRAINT outbox_messages_status_check CHECK (status IN ('PENDING', 'PUBLISHED', 'QUARANTINED'))`,
    );
    this.addSql(
      `CREATE INDEX outbox_messages_pending_due_idx ON outbox_messages (next_attempt_at, occurred_at) WHERE status = 'PENDING'`,
    );
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX outbox_messages_pending_due_idx`);
    this.addSql(`ALTER TABLE outbox_messages DROP CONSTRAINT outbox_messages_status_check`);
    this.addSql(`ALTER TABLE outbox_messages DROP COLUMN status`);
  }
}
