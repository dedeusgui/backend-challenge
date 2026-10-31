import { MikroORM } from '@mikro-orm/postgresql';
import { ormOptions } from '../../../src/shared/infrastructure/database/orm-config';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering';

/** Returns the same server URL pointed at another database name. */
function withDatabase(url: string, databaseName: string): string {
  const target = new URL(url);
  target.pathname = `/${databaseName}`;
  return target.toString();
}

/** Opens a short-lived connection to the maintenance database for DDL that cannot run in a transaction. */
async function withAdminConnection<T>(work: (orm: MikroORM) => Promise<T>): Promise<T> {
  const admin = await MikroORM.init(ormOptions(withDatabase(DATABASE_URL, 'postgres')));
  try {
    return await work(admin);
  } finally {
    await admin.close(true);
  }
}

export interface TestDatabase {
  orm: MikroORM;
  /** Closes the connection and drops the database, even when tests failed. */
  drop(): Promise<void>;
}

/**
 * Creates an isolated, migrated PostgreSQL database for one test file. Each
 * file gets its own database, so no state leaks between suites.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `wagering_test_${crypto.randomUUID().replaceAll('-', '')}`;
  await withAdminConnection((admin) =>
    admin.em.getConnection().execute(`CREATE DATABASE "${name}"`),
  );

  const orm = await MikroORM.init(ormOptions(withDatabase(DATABASE_URL, name)));
  await orm.migrator.up();

  return {
    orm,
    async drop() {
      await orm.close(true);
      await withAdminConnection((admin) =>
        admin.em.getConnection().execute(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      );
    },
  };
}
