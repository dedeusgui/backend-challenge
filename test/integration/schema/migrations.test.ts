import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type TestDatabase, createTestDatabase } from '../support/test-database';

const APPLICATION_TABLES = [
  'api_clients',
  'inbox_messages',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function publicTables(): Promise<string[]> {
  const rows = (await database.orm.em.getConnection().execute(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'
       ORDER BY table_name`,
  )) as Array<{ table_name: string }>;
  return rows.map((row) => row.table_name);
}

describe('versioned migrations', () => {
  test('creating the database from scratch yields exactly the application tables', async () => {
    expect(await publicTables()).toEqual(APPLICATION_TABLES);
  });

  test('rolling back removes every application table', async () => {
    await database.orm.migrator.down({ to: 0 });

    expect(await publicTables()).toEqual([]);
  });

  test('re-applying after a rollback restores the same schema', async () => {
    await database.orm.migrator.up();

    expect(await publicTables()).toEqual(APPLICATION_TABLES);
  });
});
