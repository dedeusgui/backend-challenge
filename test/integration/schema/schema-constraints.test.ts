import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type TestDatabase, createTestDatabase } from '../support/test-database';

/**
 * These tests bypass the application code on purpose: they prove that PostgreSQL
 * itself refuses invalid rows. SQLSTATE codes: 23505 unique, 23514 check,
 * 23503 foreign key, 22003 numeric overflow.
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

/** Runs `action` and returns the SQLSTATE it raised, or 'NO_ERROR'. */
async function sqlStateOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return findSqlState(error) ?? `UNEXPECTED: ${String(error)}`;
  }
  return 'NO_ERROR';
}

function findSqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (current !== null && typeof current === 'object') {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return code;
    }
    current =
      (current as { cause?: unknown }).cause ?? (current as { driverError?: unknown }).driverError;
  }
  return undefined;
}

function sql(query: string, params: unknown[] = []): Promise<unknown> {
  return database.orm.em.getConnection().execute(query, params);
}

async function insertWallet(
  overrides: { playerId?: string; currency?: string; balance?: string; version?: number } = {},
): Promise<string> {
  const id = randomUUID();
  await sql(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, now(), now())`,
    [
      id,
      overrides.playerId ?? `player-${randomUUID()}`,
      overrides.currency ?? 'BRL',
      overrides.balance ?? '100.00',
      overrides.version ?? 1,
    ],
  );
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
  const [wallet] = (await sql('SELECT player_id, currency FROM wallets WHERE id = ?', [
    overrides.walletId,
  ])) as Array<{ player_id: string; currency: string }>;
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
      overrides.playerId ?? wallet?.player_id ?? 'player-1',
      overrides.roundId ?? 'round-987',
      overrides.kind ?? 'BET',
      overrides.amount ?? '25.00',
      overrides.currency ?? wallet?.currency ?? 'BRL',
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
  const [wallet] = (await sql('SELECT currency FROM wallets WHERE id = ?', [
    overrides.walletId,
  ])) as Array<{ currency: string }>;
  await sql(
    `INSERT INTO wallet_ledger_entries (
       id, wallet_id, transaction_id, direction, currency, amount,
       balance_before, balance_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      randomUUID(),
      overrides.walletId,
      overrides.transactionId,
      overrides.direction ?? 'DEBIT',
      overrides.currency ?? wallet?.currency ?? 'BRL',
      overrides.amount ?? '25.00',
      overrides.balanceBefore ?? '100.00',
      overrides.balanceAfter ?? '75.00',
    ],
  );
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
      `SELECT amount::text AS amount FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
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
    const bet = await insertWager({
      walletId,
      status: 'PROCESSED',
      processedAt: new Date(),
      resultingBalance: '75.00',
    });
    const reversal = (status: string) =>
      insertWager({
        walletId,
        kind: 'REFUND',
        amount: '25.00',
        referenceExternalTransactionId: 'bet-1',
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

describe('inbox and outbox constraints', () => {
  test('deduplicates inbox messages by consumer and message id', async () => {
    const insertInbox = (consumerName: string) =>
      sql(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
         VALUES (?, 'msg-123', ?, now())`,
        [consumerName, 'b'.repeat(64)],
      );

    await insertInbox('wager-transactions');
    expect(await sqlStateOf(() => insertInbox('wager-transactions'))).toBe('23505');
    expect(await sqlStateOf(() => insertInbox('other-consumer'))).toBe('NO_ERROR');
  });

  test('keeps one outbox row per stable event id', async () => {
    const eventId = randomUUID();
    // The payload is a well-formed envelope: the shape constraint refuses anything else before this one applies.
    const payload = JSON.stringify({
      eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {},
    });
    const insertOutbox = () =>
      sql(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
         VALUES (?, 'wallet-1', 'WalletBalanceChanged', ?::jsonb, now(), now())`,
        [eventId, payload],
      );

    await insertOutbox();
    expect(await sqlStateOf(insertOutbox)).toBe('23505');
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
    const processedBet = () =>
      insertWager({
        walletId,
        status: 'PROCESSED',
        processedAt: new Date(),
        resultingBalance: '75.00',
      });
    const settle = (bet: string, kind: 'WIN' | 'REFUND') =>
      insertWager({
        walletId,
        kind,
        amount: '25.00',
        referenceExternalTransactionId: 'bet-settled',
        referenceTransactionId: bet,
        status: 'PROCESSED',
        processedAt: new Date(),
        resultingBalance: '100.00',
      });

    const resultFirst = await processedBet();
    await settle(resultFirst, 'WIN');
    expect(await sqlStateOf(() => settle(resultFirst, 'REFUND'))).toBe('23505');

    const refundFirst = await processedBet();
    await settle(refundFirst, 'REFUND');
    expect(await sqlStateOf(() => settle(refundFirst, 'WIN'))).toBe('23505');
  });
});

describe('wager_transactions: reference shape and one reversal per reference', () => {
  test('allows a WIN to carry the reference of the BET it settles', async () => {
    const walletId = await insertWallet();
    const bet = await insertWager({
      walletId,
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
