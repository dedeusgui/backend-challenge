import { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmOutboxStore } from '../src/modules/messaging/infrastructure/mikro-orm-outbox.store';
import { ormOptions } from '../src/shared/infrastructure/database/orm-config';

async function main(): Promise<void> {
  const id = process.argv[2];
  if (
    id === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new Error('Usage: bun run outbox:requeue <event-uuid>');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required');
  }
  const orm = await MikroORM.init(ormOptions(databaseUrl));
  try {
    if (!(await new MikroOrmOutboxStore(orm).requeue(id))) {
      throw new Error(`Outbox event ${id} does not exist or is not quarantined`);
    }
    console.log(JSON.stringify({ operation: 'outbox.requeue', status: 'OK', messageId: id }));
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Outbox requeue failed');
  process.exitCode = 1;
});
