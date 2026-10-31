import { MikroORM } from '@mikro-orm/postgresql';
import { ormOptions } from './shared/infrastructure/database/orm-config';

/**
 * Applies every pending migration in version order, then exits. Run once before the API
 * and the worker start. Schema changes never happen at application start-up.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required');
  }
  const orm = await MikroORM.init(ormOptions(databaseUrl));
  try {
    const applied = await orm.migrator.up();
    console.log(JSON.stringify({ operation: 'db.migrate', status: 'OK', applied: applied.length }));
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed', error);
  process.exitCode = 1;
});
