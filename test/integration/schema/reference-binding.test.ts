import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ verifyLedgerInvariant: false });
});

afterAll(async () => {
  await database.drop();
});

function findSqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return findSqlState(error.cause);
  if ('driverError' in error) return findSqlState(error.driverError);
  return undefined;
}

async function sqlStateOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return findSqlState(error) ?? `UNEXPECTED: ${String(error)}`;
  }
  return 'NO_ERROR';
}

function sql(query: string, params: unknown[] = []): Promise<unknown> {
  return database.orm.em.getConnection().execute(query, params);
}

async function fixture(): Promise<{
  walletId: string;
  targetA: string;
  targetB: string;
  externalA: string;
  externalB: string;
}> {
  const walletId = randomUUID();
  const playerId = `player-${randomUUID()}`;
  const targetA = randomUUID();
  const targetB = randomUUID();
  const externalA = `bet-a-${randomUUID()}`;
  const externalB = `bet-b-${randomUUID()}`;

  await sql(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES (?, ?, 'BRL', 0.00, 1, now(), now())`,
    [walletId, playerId],
  );
  for (const [id, externalId] of [
    [targetA, externalA],
    [targetB, externalB],
  ]) {
    await sql(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency,
         status, created_at)
       VALUES (?, 'provider-a', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'BET', 10.00, 'BRL', 'PENDING', now())`,
      [id, externalId, `key-${externalId}`, 'a'.repeat(64), walletId, playerId],
    );
  }
  return { walletId, targetA, targetB, externalA, externalB };
}

async function insertRefund(values: {
  walletId: string;
  targetId: string;
  externalId: string;
}): Promise<unknown> {
  return sql(
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency,
       reference_external_transaction_id, reference_transaction_id, status, created_at)
     SELECT ?, 'provider-a', ?, ?, ?, ?, player_id, 'round-1', 'game-1', 'REFUND', 10.00, 'BRL', ?, ?, 'PENDING', now()
       FROM wallets WHERE id = ?`,
    [
      randomUUID(),
      `refund-${randomUUID()}`,
      `refund-key-${randomUUID()}`,
      'b'.repeat(64),
      values.walletId,
      values.externalId,
      values.targetId,
      values.walletId,
    ],
  );
}

describe('wager reference external id binding', () => {
  test('rejects a refund that names target B with target A external id', async () => {
    const data = await fixture();

    expect(
      await sqlStateOf(() =>
        insertRefund({
          walletId: data.walletId,
          targetId: data.targetB,
          externalId: data.externalA,
        }),
      ),
    ).toBe('23503');
  });

  test('accepts a refund with the referenced wager external id', async () => {
    const data = await fixture();

    expect(
      await sqlStateOf(() =>
        insertRefund({
          walletId: data.walletId,
          targetId: data.targetB,
          externalId: data.externalB,
        }),
      ),
    ).toBe('NO_ERROR');
  });

  test('rejects an update that changes the target to a wager with another external id', async () => {
    const data = await fixture();
    await insertRefund({
      walletId: data.walletId,
      targetId: data.targetA,
      externalId: data.externalA,
    });
    const refund = await sql(
      `SELECT id FROM wager_transactions WHERE wallet_id = ? AND reference_transaction_id = ?`,
      [data.walletId, data.targetA],
    );
    const [row] = Array.isArray(refund) ? refund : [];
    if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string') {
      throw new Error('Inserted refund was not found');
    }

    expect(
      await sqlStateOf(() =>
        sql('UPDATE wager_transactions SET reference_transaction_id = ? WHERE id = ?', [
          data.targetB,
          row.id,
        ]),
      ),
    ).toBe('23503');
  });

  test('allows a BET with a null reference', async () => {
    const data = await fixture();

    expect(
      await sqlStateOf(() =>
        sql(
          `INSERT INTO wager_transactions (
             id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
           SELECT ?, 'provider-a', ?, ?, ?, ?, player_id, 'round-1', 'game-1', 'BET', 10.00, 'BRL', 'PENDING', now()
             FROM wallets WHERE id = ?`,
          [
            randomUUID(),
            `bet-${randomUUID()}`,
            `key-${randomUUID()}`,
            'c'.repeat(64),
            data.walletId,
            data.walletId,
          ],
        ),
      ),
    ).toBe('NO_ERROR');
  });
});
