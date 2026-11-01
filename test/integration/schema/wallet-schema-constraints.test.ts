import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sqlStateOf } from '../../support/sql-state';
import { type TestDatabase, createTestDatabase } from '../support/test-database';

/**
 * These tests bypass the application code on purpose: they prove that PostgreSQL
 * itself refuses invalid wallet and ledger rows. SQLSTATE codes: 23505 unique,
 * 23514 check, 23503 foreign key, 22003 numeric overflow.
 */

let database: TestDatabase;

beforeAll(async () => {
  // These rows are written directly to prove what the database refuses. Some of them break the
  // ledger invariant by design, so the flow-level invariant check is off for this suite only.
  database = await createTestDatabase({ verifyLedgerInvariant: false });
});

afterAll(async () => {
  await database.drop();
});

function sql(query: string, params: unknown[] = []): Promise<unknown> {
  return database.orm.em.getConnection().execute(query, params);
}

async function insertWallet(
  overrides: { playerId?: string; currency?: string; balance?: string; version?: number } = {},
): Promise<string> {
  const id = randomUUID();
  const playerId = overrides.playerId ?? `player-${randomUUID()}`;
  const currency = overrides.currency ?? 'BRL';
  const balance = overrides.balance ?? '100.00';
  await database.orm.em.fork().transactional(async (em) => {
    await em.execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, now(), now())`,
      [id, playerId, currency, balance, overrides.version ?? 1],
    );
    if (balance !== '0.00') {
      const transactionId = randomUUID();
      const externalId = `opening-${id}`;
      await em.execute(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency,
           status, resulting_balance, processed_at, created_at)
         VALUES (?, 'system', ?, ?, ?, ?, ?, 'opening', 'opening', 'OPENING', ?, ?,
                 'PROCESSED', ?, now(), now())`,
        [
          transactionId,
          externalId,
          externalId,
          'a'.repeat(64),
          id,
          playerId,
          balance,
          currency,
          balance,
        ],
      );
      await em.execute(
        `INSERT INTO wallet_ledger_entries (
           id, wallet_id, transaction_id, direction, currency, amount,
           balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'CREDIT', ?, ?, 0.00, ?, now())`,
        [randomUUID(), id, transactionId, currency, balance, balance],
      );
    }
  });
  return id;
}

interface WagerOverrides {
  id?: string;
  providerId?: string;
  playerId?: string;
  roundId?: string;
  currency?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  walletId: string;
  kind?: string;
  amount?: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status?: string;
  failureCode?: string | null;
  resultingBalance?: string | null;
  processedAt?: Date | null;
  referenceNextAttemptAt?: Date | null;
}

async function insertWager(overrides: WagerOverrides): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const externalId = overrides.externalTransactionId ?? `ext-${randomUUID()}`;
  const rows = await sql('SELECT player_id, currency FROM wallets WHERE id = ?', [
    overrides.walletId,
  ]);
  let walletPlayerId = 'player-1';
  let walletCurrency = 'BRL';
  if (Array.isArray(rows) && rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null) {
    const first = rows[0];
    if ('player_id' in first && typeof first.player_id === 'string') {
      walletPlayerId = first.player_id;
    }
    if ('currency' in first && typeof first.currency === 'string') {
      walletCurrency = first.currency;
    }
  }
  await sql(
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency,
       reference_external_transaction_id, reference_transaction_id,
       status, failure_code, resulting_balance, processed_at, reference_next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fortune-chimp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      id,
      overrides.providerId ?? 'provider-a',
      externalId,
      overrides.idempotencyKey ?? `provider-a:${externalId}`,
      'a'.repeat(64),
      overrides.walletId,
      overrides.playerId ?? walletPlayerId,
      overrides.roundId ?? 'round-987',
      overrides.kind ?? 'BET',
      overrides.amount ?? '25.00',
      overrides.currency ?? walletCurrency,
      overrides.referenceExternalTransactionId ?? null,
      overrides.referenceTransactionId ?? null,
      overrides.status ?? 'PENDING',
      overrides.failureCode ?? null,
      overrides.resultingBalance ?? null,
      overrides.processedAt ?? null,
      overrides.referenceNextAttemptAt ?? null,
    ],
  );
  return id;
}

async function insertLedgerEntry(overrides: {
  walletId: string;
  transactionId: string;
  direction?: string;
  currency?: string;
  amount?: string;
  balanceBefore?: string;
  balanceAfter?: string;
}): Promise<void> {
  const rows = await sql('SELECT currency FROM wallets WHERE id = ?', [overrides.walletId]);
  let currency = 'BRL';
  if (Array.isArray(rows) && rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null) {
    const first = rows[0];
    if ('currency' in first && typeof first.currency === 'string') {
      currency = first.currency;
    }
  }
  await database.orm.em.fork().transactional(async (em) => {
    await em.execute(
      `INSERT INTO wallet_ledger_entries (
         id, wallet_id, transaction_id, direction, currency, amount,
         balance_before, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())`,
      [
        randomUUID(),
        overrides.walletId,
        overrides.transactionId,
        overrides.direction ?? 'DEBIT',
        overrides.currency ?? currency,
        overrides.amount ?? '25.00',
        overrides.balanceBefore ?? '100.00',
        overrides.balanceAfter ?? '75.00',
      ],
    );
    await em.execute(
      `UPDATE wallets SET balance = ?, version = version + 1, updated_at = now() WHERE id = ?`,
      [overrides.balanceAfter ?? '75.00', overrides.walletId],
    );
  });
}

describe('wallets constraints', () => {
  test('allow only one wallet per player and currency', async () => {
    const playerId = `player-${randomUUID()}`;
    await insertWallet({ playerId });

    expect(await sqlStateOf(() => insertWallet({ playerId }))).toBe('23505');
  });

  test('allow the same player to hold a wallet in another currency', async () => {
    const playerId = `player-${randomUUID()}`;
    await insertWallet({ playerId, currency: 'BRL' });

    expect(await sqlStateOf(() => insertWallet({ playerId, currency: 'USD' }))).toBe('NO_ERROR');
  });

  test('reject a negative balance', async () => {
    expect(await sqlStateOf(() => insertWallet({ balance: '-0.01' }))).toBe('23514');
  });

  test('reject a version below 1', async () => {
    expect(await sqlStateOf(() => insertWallet({ version: 0 }))).toBe('23514');
  });

  test('reject a currency that is not three uppercase letters', async () => {
    expect(await sqlStateOf(() => insertWallet({ currency: 'brl' }))).toBe('23514');
  });

  test('reject a balance beyond NUMERIC(20,2), with 19 integer digits', async () => {
    expect(await sqlStateOf(() => insertWallet({ balance: '1000000000000000000.00' }))).toBe(
      '22003',
    );
  });
});

describe('wallet_ledger_entries constraints', () => {
  test('is append-only: UPDATE is refused', async () => {
    const walletId = await insertWallet();
    const transactionId = await insertWager({
      walletId,
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });
    await insertLedgerEntry({ walletId, transactionId });

    const error = await sqlStateOf(() =>
      sql(`UPDATE wallet_ledger_entries SET amount = 1.00 WHERE wallet_id = ?`, [walletId]),
    );
    expect(error).not.toBe('NO_ERROR');
    const remaining = await sql(
      `SELECT amount::text AS amount FROM wallet_ledger_entries WHERE wallet_id = ? AND transaction_id = ?`,
      [walletId, transactionId],
    );
    expect(remaining).toEqual([{ amount: '25.00' }]);
  });

  test('is append-only: DELETE is refused', async () => {
    const walletId = await insertWallet();
    const transactionId = await insertWager({
      walletId,
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });
    await insertLedgerEntry({ walletId, transactionId });

    expect(
      await sqlStateOf(() =>
        sql(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId]),
      ),
    ).not.toBe('NO_ERROR');
  });

  test('is append-only: TRUNCATE is refused', async () => {
    expect(await sqlStateOf(() => sql(`TRUNCATE wallet_ledger_entries`))).not.toBe('NO_ERROR');
  });

  test('rejects an entry whose arithmetic does not balance', async () => {
    const walletId = await insertWallet();
    const transactionId = await insertWager({ walletId });

    expect(
      await sqlStateOf(() => insertLedgerEntry({ walletId, transactionId, balanceAfter: '74.00' })),
    ).toBe('23514');
  });

  test('rejects a CREDIT recorded with debit arithmetic', async () => {
    const walletId = await insertWallet();
    const transactionId = await insertWager({ walletId });

    expect(
      await sqlStateOf(() =>
        insertLedgerEntry({
          walletId,
          transactionId,
          direction: 'CREDIT',
          balanceBefore: '100.00',
          balanceAfter: '75.00',
        }),
      ),
    ).toBe('23514');
  });

  test('rejects a zero amount', async () => {
    const walletId = await insertWallet();
    const transactionId = await insertWager({ walletId });

    expect(
      await sqlStateOf(() =>
        insertLedgerEntry({ walletId, transactionId, amount: '0.00', balanceAfter: '100.00' }),
      ),
    ).toBe('23514');
  });

  test('rejects two entries for the same wallet and transaction', async () => {
    const walletId = await insertWallet();
    const transactionId = await insertWager({ walletId });
    await insertLedgerEntry({ walletId, transactionId });

    expect(await sqlStateOf(() => insertLedgerEntry({ walletId, transactionId }))).toBe('23505');
  });

  test('rejects an entry whose transaction belongs to another wallet', async () => {
    const walletA = await insertWallet();
    const walletB = await insertWallet();
    const transactionOfB = await insertWager({ walletId: walletB });

    expect(
      await sqlStateOf(() =>
        insertLedgerEntry({ walletId: walletA, transactionId: transactionOfB }),
      ),
    ).toBe('23503');
  });
});
