import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sqlStateOf } from '../../support/sql-state';
import { type TestDatabase, createTestDatabase } from '../support/test-database';

/**
 * These tests bypass the application code on purpose: they prove that PostgreSQL
 * itself refuses invalid wager_transactions rows. SQLSTATE codes: 23505 unique,
 * 23514 check, 23503 foreign key.
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

describe('wager_transactions identity and shape', () => {
  test('rejects a duplicate external transaction id within a provider', async () => {
    const walletId = await insertWallet();
    await insertWager({ walletId, externalTransactionId: 'transaction-123' });

    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId,
          externalTransactionId: 'transaction-123',
          idempotencyKey: 'other-key',
        }),
      ),
    ).toBe('23505');
  });

  test('rejects a duplicate idempotency key within a provider', async () => {
    const walletId = await insertWallet();
    await insertWager({ walletId, idempotencyKey: 'provider-a:key-1' });

    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId,
          externalTransactionId: 'another-id',
          idempotencyKey: 'provider-a:key-1',
        }),
      ),
    ).toBe('23505');
  });

  test('allows the same idempotency key under a different provider', async () => {
    const walletId = await insertWallet();
    await insertWager({ walletId, providerId: 'provider-a', idempotencyKey: 'shared-key' });

    expect(
      await sqlStateOf(() =>
        insertWager({ walletId, providerId: 'provider-b', idempotencyKey: 'shared-key' }),
      ),
    ).toBe('NO_ERROR');
  });

  test('rejects an unknown kind, so OPENING_BONUS cannot be stored', async () => {
    const walletId = await insertWallet();
    expect(await sqlStateOf(() => insertWager({ walletId, kind: 'OPENING_BONUS' }))).toBe('23514');
  });

  test('rejects a REFUND without a reference', async () => {
    const walletId = await insertWallet();
    expect(await sqlStateOf(() => insertWager({ walletId, kind: 'REFUND' }))).toBe('23514');
  });

  test('rejects a BET that carries a reference', async () => {
    const walletId = await insertWallet();
    expect(
      await sqlStateOf(() =>
        insertWager({ walletId, kind: 'BET', referenceExternalTransactionId: 'x' }),
      ),
    ).toBe('23514');
  });

  test('rejects a PROCESSED transaction without processed_at and resulting balance', async () => {
    const walletId = await insertWallet();
    expect(await sqlStateOf(() => insertWager({ walletId, status: 'PROCESSED' }))).toBe('23514');
  });

  test('rejects a REJECTED transaction without a failure code', async () => {
    const walletId = await insertWallet();
    expect(await sqlStateOf(() => insertWager({ walletId, status: 'REJECTED' }))).toBe('23514');
  });

  test('rejects a REJECTED transaction without the balance observed when it was rejected', async () => {
    const walletId = await insertWallet();
    expect(
      await sqlStateOf(() =>
        insertWager({ walletId, status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' }),
      ),
    ).toBe('23514');
  });

  test('rejects a PENDING transaction that already carries a failure code', async () => {
    const walletId = await insertWallet();
    expect(
      await sqlStateOf(() =>
        insertWager({ walletId, status: 'PENDING', failureCode: 'INSUFFICIENT_BALANCE' }),
      ),
    ).toBe('23514');
  });
});

describe('wager_transactions: a held transaction keeps the balance it was held with', () => {
  test('rejects a PENDING_REFERENCE without the balance observed when it was held', async () => {
    const walletId = await insertWallet();

    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId,
          kind: 'REFUND',
          referenceExternalTransactionId: 'bet-late',
          status: 'PENDING_REFERENCE',
          referenceNextAttemptAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).toBe('23514');
  });

  test('accepts a PENDING_REFERENCE that carries the balance observed when it was held', async () => {
    const walletId = await insertWallet();

    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId,
          kind: 'REFUND',
          referenceExternalTransactionId: 'bet-late',
          status: 'PENDING_REFERENCE',
          resultingBalance: '100.00',
          referenceNextAttemptAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).toBe('NO_ERROR');
  });
});

describe('wager_transactions references', () => {
  test('rejects a reference to a transaction of another wallet', async () => {
    const walletA = await insertWallet();
    const walletB = await insertWallet();
    const betOfB = await insertWager({
      walletId: walletB,
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });

    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId: walletA,
          kind: 'REFUND',
          amount: '25.00',
          referenceExternalTransactionId: 'bet-of-b',
          referenceTransactionId: betOfB,
        }),
      ),
    ).toBe('23503');
  });

  test('rejects a reference to a transaction of another provider', async () => {
    const walletId = await insertWallet();
    const betOfProviderB = await insertWager({
      walletId,
      providerId: 'provider-b',
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });

    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId,
          providerId: 'provider-a',
          kind: 'REFUND',
          amount: '25.00',
          referenceExternalTransactionId: 'bet-of-b',
          referenceTransactionId: betOfProviderB,
        }),
      ),
    ).toBe('23503');
  });

  test('allows only one PROCESSED refund per reference', async () => {
    const walletId = await insertWallet();
    const bet = await insertWager({
      walletId,
      externalTransactionId: 'bet-1',
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });
    const refund = (status: string) =>
      insertWager({
        walletId,
        kind: 'REFUND',
        amount: '25.00',
        referenceExternalTransactionId: 'bet-1',
        referenceTransactionId: bet,
        status,
        ...(status === 'PROCESSED'
          ? { processedAt: new Date(), resultingBalance: '100.00' }
          : { failureCode: 'REFERENCE_ALREADY_REVERSED' }),
      });

    await refund('PROCESSED');
    expect(await sqlStateOf(() => refund('PROCESSED'))).toBe('23505');
  });

  test('keeps a rejected second refund as an auditable row', async () => {
    const walletId = await insertWallet();
    const betExternalId = 'bet-1-auditable';
    const bet = await insertWager({
      walletId,
      externalTransactionId: betExternalId,
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });
    const reversal = (status: string) =>
      insertWager({
        walletId,
        kind: 'REFUND',
        amount: '25.00',
        referenceExternalTransactionId: betExternalId,
        referenceTransactionId: bet,
        status,
        failureCode: status === 'REJECTED' ? 'REFERENCE_ALREADY_REVERSED' : null,
        processedAt: status === 'PROCESSED' ? new Date() : null,
        // A rejection stores the balance observed when it was decided, which is the balance after the BET.
        resultingBalance: status === 'PROCESSED' ? '100.00' : '75.00',
      });

    await reversal('PROCESSED');
    expect(await sqlStateOf(() => reversal('REJECTED'))).toBe('NO_ERROR');
  });

  test('rejects a PROCESSED rollback whose reference was never resolved', async () => {
    const walletId = await insertWallet();
    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId,
          kind: 'ROLLBACK',
          amount: '25.00',
          referenceExternalTransactionId: 'bet-1',
          status: 'PROCESSED',
          processedAt: new Date(),
          resultingBalance: '100.00',
        }),
      ),
    ).toBe('23514');
  });
});

describe('wager_transactions: results name their BET, and a BET has one result', () => {
  test('a WIN or a LOSS may omit the reference of its BET, as the specification allows', async () => {
    const walletId = await insertWallet();

    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId,
          kind: 'WIN',
          amount: '40.00',
          status: 'PROCESSED',
          processedAt: new Date(),
          resultingBalance: '140.00',
        }),
      ),
    ).toBe('NO_ERROR');
    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId,
          kind: 'LOSS',
          amount: '0.00',
          status: 'PROCESSED',
          processedAt: new Date(),
          resultingBalance: '100.00',
        }),
      ),
    ).toBe('NO_ERROR');
  });

  test('allows only one PROCESSED result per BET', async () => {
    const walletId = await insertWallet();
    const bet = await insertWager({
      walletId,
      externalTransactionId: 'bet-result',
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });
    const result = (kind: 'WIN' | 'LOSS') =>
      insertWager({
        walletId,
        kind,
        amount: kind === 'WIN' ? '40.00' : '0.00',
        referenceExternalTransactionId: 'bet-result',
        referenceTransactionId: bet,
        status: 'PROCESSED',
        processedAt: new Date(),
        resultingBalance: '115.00',
      });

    await result('WIN');
    expect(await sqlStateOf(() => result('LOSS'))).toBe('23505');
    expect(await sqlStateOf(() => result('WIN'))).toBe('23505');
  });

  test('a BET cannot have a processed result and a processed refund, in either order', async () => {
    const walletId = await insertWallet();
    const processedBet = (externalTransactionId: string) =>
      insertWager({
        walletId,
        externalTransactionId,
        status: 'PROCESSED',
        processedAt: new Date(),
        resultingBalance: '75.00',
      });
    const settle = (bet: string, externalId: string, kind: 'WIN' | 'REFUND') =>
      insertWager({
        walletId,
        kind,
        amount: '25.00',
        referenceExternalTransactionId: externalId,
        referenceTransactionId: bet,
        status: 'PROCESSED',
        processedAt: new Date(),
        resultingBalance: '100.00',
      });

    const resultFirstExternalId = 'bet-settled-result-first';
    const resultFirst = await processedBet(resultFirstExternalId);
    await settle(resultFirst, resultFirstExternalId, 'WIN');
    expect(await sqlStateOf(() => settle(resultFirst, resultFirstExternalId, 'REFUND'))).toBe(
      '23505',
    );

    const refundFirstExternalId = 'bet-settled-refund-first';
    const refundFirst = await processedBet(refundFirstExternalId);
    await settle(refundFirst, refundFirstExternalId, 'REFUND');
    expect(await sqlStateOf(() => settle(refundFirst, refundFirstExternalId, 'WIN'))).toBe('23505');
  });
});

describe('wager_transactions: reference shape and one reversal per reference', () => {
  test('allows a WIN to carry the reference of the BET it settles', async () => {
    const walletId = await insertWallet();
    const bet = await insertWager({
      walletId,
      externalTransactionId: 'bet-of-win',
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });

    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId,
          kind: 'WIN',
          amount: '40.00',
          referenceExternalTransactionId: 'bet-of-win',
          referenceTransactionId: bet,
          status: 'PROCESSED',
          processedAt: new Date(),
          resultingBalance: '115.00',
        }),
      ),
    ).toBe('NO_ERROR');
  });

  test('allows only one PROCESSED reversal per reference, whatever its kind', async () => {
    const walletId = await insertWallet();
    const bet = await insertWager({
      walletId,
      externalTransactionId: 'bet-once',
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });
    const reversal = (kind: string) =>
      insertWager({
        walletId,
        kind,
        amount: '25.00',
        referenceExternalTransactionId: 'bet-once',
        referenceTransactionId: bet,
        status: 'PROCESSED',
        processedAt: new Date(),
        resultingBalance: '100.00',
      });

    await reversal('REFUND');
    expect(await sqlStateOf(() => reversal('ROLLBACK'))).toBe('23505');
  });
});

describe('wager_transactions: amount, wallet context and round are checked by the database', () => {
  test('a zero amount is refused for every kind except LOSS', async () => {
    const walletId = await insertWallet();
    const bet = await insertWager({
      walletId,
      externalTransactionId: 'bet-zero',
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });
    const loss = (amount: string) =>
      insertWager({
        walletId,
        kind: 'LOSS',
        amount,
        referenceExternalTransactionId: 'bet-zero',
        referenceTransactionId: bet,
        status: 'PROCESSED',
        processedAt: new Date(),
        resultingBalance: '75.00',
      });

    expect(await sqlStateOf(() => insertWager({ walletId, kind: 'BET', amount: '0.00' }))).toBe(
      '23514',
    );
    expect(await sqlStateOf(() => loss('0.00'))).toBe('NO_ERROR');
  });

  test('a rejected transaction keeps the player and currency it was submitted with', async () => {
    // A WALLET_PLAYER_MISMATCH or WALLET_CURRENCY_MISMATCH rejection is a row, not an error, so the
    // database accepts it. The domain is the only check of the player and the currency.
    const walletId = await insertWallet({ playerId: 'player-owner', currency: 'BRL' });

    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId,
          playerId: 'player-stranger',
          currency: 'USD',
          status: 'REJECTED',
          failureCode: 'WALLET_PLAYER_MISMATCH',
          resultingBalance: '100.00',
        }),
      ),
    ).toBe('NO_ERROR');
  });

  test('a ledger entry takes the currency of its wallet', async () => {
    const walletId = await insertWallet({ currency: 'BRL' });
    const bet = await insertWager({
      walletId,
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });

    expect(
      await sqlStateOf(() => insertLedgerEntry({ walletId, transactionId: bet, currency: 'USD' })),
    ).toBe('23503');
  });

  test('a reference must be a transaction of the same round', async () => {
    const walletId = await insertWallet();
    const bet = await insertWager({
      walletId,
      roundId: 'round-A',
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });

    expect(
      await sqlStateOf(() =>
        insertWager({
          walletId,
          kind: 'WIN',
          amount: '40.00',
          roundId: 'round-B',
          referenceExternalTransactionId: 'bet-round-a',
          referenceTransactionId: bet,
          status: 'PROCESSED',
          processedAt: new Date(),
          resultingBalance: '115.00',
        }),
      ),
    ).toBe('23503');
  });
});
