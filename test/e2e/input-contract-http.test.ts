import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { startTestApp, type TestApp } from './support/test-app';

/**
 * The input contract: a malformed identifier, amount or cursor is a 400 that names the field.
 * Before this suite, several of these reached PostgreSQL and came back as 500 INTERNAL_ERROR.
 */

let database: TestDatabase;
let app: TestApp;
let operatorKey = '';
let providerKey = '';

beforeAll(async () => {
  database = await createTestDatabase();
  app = await startTestApp(database.url);
  operatorKey = (await app.createApiClient({ name: 'operator', role: 'OPERATOR' })).apiKey;
  providerKey = (
    await app.createApiClient({ name: 'provider a', role: 'PROVIDER', providerId: 'provider-a' })
  ).apiKey;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function send(
  method: string,
  path: string,
  key: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function errorCodeOf(result: HttpResult): unknown {
  const error = result.body.error;
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

async function openWallet(amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = randomUUID();
  const created = await send('POST', '/wallets', operatorKey, {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(created.status).toBe(201);
  return { walletId: String(created.body.id), playerId };
}

function submission(
  wallet: { walletId: string; playerId: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
    ...overrides,
  };
}

function keyFor(body: Record<string, unknown>): Record<string, string> {
  return { 'idempotency-key': `provider-a:${String(body.externalTransactionId)}` };
}

describe('an identifier that is not a UUID is 400 INVALID_REQUEST', () => {
  test('a malformed walletId in a submission is refused before the database', async () => {
    const body = submission({ walletId: 'not-a-uuid', playerId: randomUUID() });

    const result = await send('POST', '/wagering/transactions', providerKey, body, keyFor(body));

    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('INVALID_REQUEST');
  });

  test.each([
    ['get a wallet', 'GET', '/wallets/not-a-uuid', 'operator'],
    ['read the ledger', 'GET', '/wallets/not-a-uuid/ledger', 'operator'],
    ['reconcile', 'POST', '/wallets/not-a-uuid/reconciliation', 'operator'],
    ['get a transaction', 'GET', '/wagering/transactions/not-a-uuid', 'provider'],
  ] as const)('%s with a malformed id is 400', async (_label, method, path, role) => {
    const result = await send(method, path, role === 'operator' ? operatorKey : providerKey);

    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('INVALID_REQUEST');
  });
});

describe('a control character in an identifier is 400 INVALID_REQUEST', () => {
  test('a NUL character in externalTransactionId is refused, not stored', async () => {
    const wallet = await openWallet('100.00');
    const body = submission(wallet, { externalTransactionId: 'bet\u0000one' });

    const result = await send('POST', '/wagering/transactions', providerKey, body, {
      'idempotency-key': `provider-a:${randomUUID()}`,
    });

    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('INVALID_REQUEST');
  });

  test('a control character in the Idempotency-Key is refused, as the queue refuses it, and nothing is stored', async () => {
    const wallet = await openWallet('100.00');
    const body = submission(wallet);
    const externalTransactionId = String(body.externalTransactionId);

    const result = await send('POST', '/wagering/transactions', providerKey, body, {
      'idempotency-key': `provider-a:${externalTransactionId}\tsuffix`,
    });

    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('INVALID_REQUEST');
    const lookup = await send(
      'GET',
      `/providers/provider-a/wagering/transactions/${externalTransactionId}`,
      providerKey,
    );
    expect(lookup.status).toBe(404);
  });

  test('a NUL character in playerId when opening a wallet is refused', async () => {
    const result = await send('POST', '/wallets', operatorKey, {
      playerId: 'player\u0000one',
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });

    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('INVALID_REQUEST');
  });

  test('a NUL character in a provider lookup path is 400, not a server error', async () => {
    const result = await send(
      'GET',
      '/providers/provider-a/wagering/transactions/bet%00one',
      providerKey,
    );

    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('INVALID_REQUEST');
  });
});

describe('the ledger cursor', () => {
  test('a cursor whose sequence exceeds the bigint range is 400 INVALID_CURSOR', async () => {
    const wallet = await openWallet('100.00');
    const cursor = Buffer.from(JSON.stringify({ seq: '9'.repeat(30) })).toString('base64url');

    const result = await send(
      'GET',
      `/wallets/${wallet.walletId}/ledger?cursor=${cursor}`,
      operatorKey,
    );

    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('INVALID_CURSOR');
  });
});

describe('a credit that would exceed the largest storable balance', () => {
  test('is REJECTED with BALANCE_LIMIT_EXCEEDED (422), and the balance does not change', async () => {
    const wallet = await openWallet('999999999999999999.99');
    const body = submission(wallet, {
      kind: 'WIN',
      money: { amount: '0.01', currency: 'BRL' },
    });

    const result = await send('POST', '/wagering/transactions', providerKey, body, keyFor(body));

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'BALANCE_LIMIT_EXCEEDED',
      balance: { amount: '999999999999999999.99', currency: 'BRL' },
    });
    const after = await send('GET', `/wallets/${wallet.walletId}`, operatorKey);
    expect(after.body).toMatchObject({ balance: { amount: '999999999999999999.99' } });
  });
});

describe('a malformed monetary amount is 400', () => {
  test.each([
    ['scientific notation', '1e3'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['a negative amount', '-1.00'],
    ['three decimals', '1.234'],
    ['an empty string', ''],
    ['a comma separator', '1,00'],
    ['a leading plus sign', '+1.00'],
    ['letters', 'abc'],
  ])('%s is INVALID_MONEY', async (_label, amount) => {
    const wallet = await openWallet('100.00');
    const body = submission(wallet, { money: { amount, currency: 'BRL' } });

    const result = await send('POST', '/wagering/transactions', providerKey, body, keyFor(body));

    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('INVALID_MONEY');
  });

  test('an amount that is a JSON number is INVALID_REQUEST, because money never travels as a number', async () => {
    const wallet = await openWallet('100.00');
    const body = submission(wallet, { money: { amount: 25, currency: 'BRL' } });

    const result = await send('POST', '/wagering/transactions', providerKey, body, keyFor(body));

    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('INVALID_REQUEST');
  });
});

describe('a monetary amount has exactly two decimals', () => {
  test.each(['25', '25.1'])('an opening balance of "%s" is 400 INVALID_MONEY', async (amount) => {
    const result = await send('POST', '/wallets', operatorKey, {
      playerId: randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
    });
    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('INVALID_MONEY');
  });

  test.each(['25', '25.1'])(
    'a BET of "%s" is 400 INVALID_MONEY, and no balance, ledger row or transaction is written',
    async (amount) => {
      const wallet = await openWallet('100.00');
      const externalTransactionId = `tx-${randomUUID()}`;
      const result = await send(
        'POST',
        '/wagering/transactions',
        providerKey,
        submission(wallet, { externalTransactionId, money: { amount, currency: 'BRL' } }),
        { 'idempotency-key': `provider-a:${externalTransactionId}` },
      );
      expect(result.status).toBe(400);
      expect(errorCodeOf(result)).toBe('INVALID_MONEY');

      const after = await send('GET', `/wallets/${wallet.walletId}`, operatorKey);
      expect(after.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      const ledger = await send('GET', `/wallets/${wallet.walletId}/ledger`, operatorKey);
      expect((ledger.body.entries as unknown[]).length).toBe(1);
      const lookup = await send(
        'GET',
        `/providers/provider-a/wagering/transactions/${externalTransactionId}`,
        providerKey,
      );
      expect(lookup.status).toBe(404);
    },
  );
});

describe('the correlation id is bounded and well formed', () => {
  // The identifier is checked before the wallet is looked up, so a random wallet id is enough.
  const submitWithCorrelation = (correlationId: string) =>
    send(
      'POST',
      '/wagering/transactions',
      providerKey,
      {
        providerId: 'provider-a',
        externalTransactionId: `corr-${randomUUID()}`,
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
      { 'idempotency-key': `provider-a:${randomUUID()}`, 'x-correlation-id': correlationId },
    );

  test('an identifier longer than 128 characters is 400 INVALID_REQUEST', async () => {
    const result = await submitWithCorrelation('c'.repeat(129));
    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('INVALID_REQUEST');
  });

  test.each(['has space', 'quote"here', 'semi;colon'])(
    '%p is outside the allowed characters, so it is 400 INVALID_REQUEST',
    async (correlationId) => {
      const result = await submitWithCorrelation(correlationId);
      expect(result.status).toBe(400);
      expect(errorCodeOf(result)).toBe('INVALID_REQUEST');
    },
  );

  test('a bounded identifier of allowed characters reaches the use case', async () => {
    const result = await submitWithCorrelation('req.2026-07_31:alpha');
    expect(result.status).toBe(404);
    expect(errorCodeOf(result)).toBe('WALLET_NOT_FOUND');
  });
});

describe('the JSON body has an explicit limit', () => {
  test('a body above the limit is 413 PAYLOAD_TOO_LARGE, before authentication or parsing', async () => {
    const result = await send('POST', '/wallets', operatorKey, { padding: 'x'.repeat(20_000) });
    expect(result.status).toBe(413);
    expect(errorCodeOf(result)).toBe('PAYLOAD_TOO_LARGE');
  });
});
