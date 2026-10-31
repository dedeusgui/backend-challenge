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

/** Fails the suite when any wallet's materialized balance disagrees with its ledger. */
async function assertLedgerInvariant(orm: MikroORM): Promise<void> {
  const rows = (await orm.em.getConnection().execute(
    `SELECT w.id, w.balance::text AS balance,
            COALESCE((SELECT SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END)
                        FROM wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)::text AS ledger
       FROM wallets w
      WHERE w.balance <> COALESCE((SELECT SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END)
                                     FROM wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)`,
  )) as Array<{ id: string; balance: string; ledger: string }>;
  if (rows.length > 0) {
    throw new Error(`Ledger invariant violated: ${JSON.stringify(rows.slice(0, 3))}`);
  }
}

export interface TestDatabase {
  orm: MikroORM;
  /** Connection URL of this isolated database, for starting processes against it. */
  url: string;
  /** Closes the connection and drops the database, even when tests failed. */
  drop(): Promise<void>;
}

/**
 * Creates an isolated, migrated PostgreSQL database for one test file. Each
 * file gets its own database, so no state leaks between suites.
 */
export interface TestDatabaseOptions {
  /**
   * Whether teardown checks that every wallet equals its ledger sum. Suites that write rows
   * directly to prove a database rule may build states that break the invariant on purpose,
   * and turn this off; every flow-level suite keeps it on.
   */
  verifyLedgerInvariant?: boolean;
}

export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const name = `wagering_test_${crypto.randomUUID().replaceAll('-', '')}`;
  await withAdminConnection((admin) =>
    admin.em.getConnection().execute(`CREATE DATABASE "${name}"`),
  );

  const url = withDatabase(DATABASE_URL, name);
  const orm = await MikroORM.init(ormOptions(url));
  await orm.migrator.up();

  return {
    orm,
    url,
    async drop() {
      // Every test database ends with the global invariant: each wallet's balance equals its ledger sum.
      if (options.verifyLedgerInvariant ?? true) {
        await assertLedgerInvariant(orm);
      }
      await orm.close(true);
      await withAdminConnection((admin) =>
        admin.em.getConnection().execute(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      );
    },
  };
}
