import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { duplicateAuditSql, PRODUCTION_TABLES, type AuditTables } from '../../load/audit';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * The duplicate audit that closes a load step, run against real PostgreSQL. The real tables cannot hold a
 * duplicate, which is their job, so each case writes the rows into probe tables with the same columns and no
 * constraint. The audit must count a duplicate where the API's identity is violated, and nothing where two
 * providers merely share an external id.
 */

let database: TestDatabase;
let tables: AuditTables;

beforeAll(async () => {
  database = await createTestDatabase();
  const suffix = randomUUID().replaceAll('-', '');
  tables = {
    transactions: `audit_transactions_${suffix}`,
    ledger: `audit_ledger_${suffix}`,
  };
  const connection = database.orm.em.getConnection();
  await connection.execute(
    `CREATE TABLE ${tables.transactions} (provider_id text, external_transaction_id text, idempotency_key text, id uuid)`,
  );
  await connection.execute(`CREATE TABLE ${tables.ledger} (transaction_id uuid, wallet_id uuid)`);
}, 60_000);

afterAll(async () => {
  await database.drop();
});

async function reset(): Promise<void> {
  const connection = database.orm.em.getConnection();
  await connection.execute(`DELETE FROM ${tables.transactions}`);
  await connection.execute(`DELETE FROM ${tables.ledger}`);
}

async function addTransaction(provider: string, external: string, key: string): Promise<string> {
  const id = randomUUID();
  await database.orm.em
    .getConnection()
    .execute(`INSERT INTO ${tables.transactions} VALUES (?, ?, ?, ?)`, [
      provider,
      external,
      key,
      id,
    ]);
  return id;
}

async function duplicates(): Promise<number> {
  const rows = (await database.orm.em.getConnection().execute(duplicateAuditSql(tables))) as Array<{
    duplicates: string;
  }>;
  return Number(rows[0]?.duplicates ?? Number.NaN);
}

describe('the duplicate audit, against PostgreSQL', () => {
  test('a clean state has no duplicate', async () => {
    await reset();
    await addTransaction('provider-a', 'bet-1', 'provider-a:bet-1');
    await addTransaction('provider-a', 'bet-2', 'provider-a:bet-2');
    expect(await duplicates()).toBe(0);
  });

  test('two providers that use the same external id are two transactions, not a duplicate', async () => {
    await reset();
    await addTransaction('provider-a', 'shared-id', 'provider-a:shared-id');
    await addTransaction('provider-b', 'shared-id', 'provider-b:shared-id');
    expect(await duplicates()).toBe(0);
  });

  test('the same external id under one provider is a duplicate identity', async () => {
    await reset();
    await addTransaction('provider-a', 'bet-1', 'provider-a:bet-1');
    await addTransaction('provider-a', 'bet-1', 'provider-a:other-key');
    expect(await duplicates()).toBe(1);
  });

  test('the same idempotency key under one provider is a duplicate key', async () => {
    await reset();
    await addTransaction('provider-a', 'bet-1', 'provider-a:same');
    await addTransaction('provider-a', 'bet-2', 'provider-a:same');
    expect(await duplicates()).toBe(1);
  });

  test('one transaction with two ledger entries was applied twice', async () => {
    await reset();
    const id = await addTransaction('provider-a', 'bet-1', 'provider-a:bet-1');
    const connection = database.orm.em.getConnection();
    await connection.execute(`INSERT INTO ${tables.ledger} VALUES (?, ?)`, [id, randomUUID()]);
    await connection.execute(`INSERT INTO ${tables.ledger} VALUES (?, ?)`, [id, randomUUID()]);
    expect(await duplicates()).toBe(1);
  });

  test('the scope of the previous audit, by external id alone, counted two providers as one duplicate', async () => {
    await reset();
    await addTransaction('provider-a', 'shared-id', 'provider-a:shared-id');
    await addTransaction('provider-b', 'shared-id', 'provider-b:shared-id');
    const rows = (await database.orm.em
      .getConnection()
      .execute(
        `SELECT count(*)::text AS n FROM (SELECT external_transaction_id FROM ${tables.transactions} GROUP BY external_transaction_id HAVING count(*) > 1) d`,
      )) as Array<{ n: string }>;
    expect(Number(rows[0]?.n)).toBe(1);
    expect(await duplicates()).toBe(0);
  });

  test('the same statement runs on the real schema, and a fresh database has no duplicate', async () => {
    const rows = (await database.orm.em
      .getConnection()
      .execute(duplicateAuditSql(PRODUCTION_TABLES))) as Array<{ duplicates: string }>;
    expect(rows[0]?.duplicates).toBe('0');
  });
});
