import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, expect, spyOn, test } from 'bun:test';
import { ormOptions } from '../../../src/shared/infrastructure/database/orm-config';
import { createTestDatabase, DATABASE_URL } from './test-database';

let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;

afterAll(async () => {
  await database?.drop().catch(() => {});
});

test('drops the database even when the teardown invariant query fails, and can be repeated', async () => {
  database = await createTestDatabase();
  const name = new URL(database.url).pathname.slice(1);
  await database.orm.em.getConnection().execute(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES ('00000000-0000-0000-0000-000000000001', 'cleanup-test', 'BRL', 0, 1, now(), now())`,
  );
  await database.orm.em
    .getConnection()
    .execute('ALTER TABLE wallets DISABLE TRIGGER wallets_ledger_balance_check');
  await database.orm.em
    .getConnection()
    .execute(
      `UPDATE wallets SET balance = 1, version = 2 WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
  await database.orm.em
    .getConnection()
    .execute('ALTER TABLE wallets ENABLE TRIGGER wallets_ledger_balance_check');

  await expect(database.drop()).rejects.toThrow();

  const admin = await MikroORM.init(ormOptions(DATABASE_URL));
  try {
    const rows = (await admin.em
      .getConnection()
      .execute('SELECT 1 FROM pg_database WHERE datname = ?', [name])) as unknown[];
    expect(rows).toHaveLength(0);
  } finally {
    await admin.close(true);
  }

  await expect(database.drop()).resolves.toBeUndefined();
});

test('drops a newly created database when the real migration connection fails', async () => {
  let databaseName: string | undefined;
  let created: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  try {
    const creation = (async () => {
      created = await createTestDatabase({
        migrate: async (orm, url) => {
          databaseName = new URL(url).pathname.slice(1);
          await orm.em.getConnection().execute('SELECT 1 / 0');
        },
      });
    })();
    await expect(creation).rejects.toThrow(/division by zero/i);
    expect(databaseName).toBeString();

    const admin = await MikroORM.init(ormOptions(DATABASE_URL));
    try {
      const rows = (await admin.em
        .getConnection()
        .execute('SELECT 1 FROM pg_database WHERE datname = ?', [databaseName])) as unknown[];
      expect(rows).toHaveLength(0);
    } finally {
      await admin.close(true);
    }
  } finally {
    await created?.drop().catch(() => {});
  }
});

test('keeps invariant, ORM close, and database removal errors together', async () => {
  const failedDatabase = await createTestDatabase();
  await failedDatabase.orm.em.getConnection().execute(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES ('00000000-0000-0000-0000-000000000002', 'cleanup-errors', 'BRL', 0, 1, now(), now())`,
  );
  await failedDatabase.orm.em
    .getConnection()
    .execute('ALTER TABLE wallets DISABLE TRIGGER wallets_ledger_balance_check');
  await failedDatabase.orm.em
    .getConnection()
    .execute(
      `UPDATE wallets SET balance = 1, version = 2 WHERE id = '00000000-0000-0000-0000-000000000002'`,
    );
  await failedDatabase.orm.em
    .getConnection()
    .execute('ALTER TABLE wallets ENABLE TRIGGER wallets_ledger_balance_check');

  const closeFailure = new Error('ORM close failure');
  const removeFailure = new Error('database removal failure');
  const close = spyOn(failedDatabase.orm, 'close').mockRejectedValue(closeFailure);
  const init = spyOn(MikroORM, 'init').mockRejectedValue(removeFailure);
  try {
    const failure = await failedDatabase.drop().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(errors).toHaveLength(3);
    expect(String(errors[0])).toContain('Ledger invariant violated');
    expect(errors[1]).toBe(closeFailure);
    expect(errors[2]).toBe(removeFailure);
  } finally {
    init.mockRestore();
    close.mockRestore();
    await failedDatabase.drop().catch(() => {});
  }
});
