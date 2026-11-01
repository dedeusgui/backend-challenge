import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000015 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `CREATE INDEX outbox_messages_published_retention_idx
         ON outbox_messages (published_at, id)
       WHERE status = 'PUBLISHED' AND published_at IS NOT NULL`,
    );
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX outbox_messages_published_retention_idx`);
  }
}
