import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { startTestApp, type TestApp } from './support/test-app';
import { required } from '../support/required';

/**
 * Adversarial checks of the API key layer. Each test tries to reach something a caller may not reach,
 * by a path, a header or an identifier that a lazier check would miss. A test that passes here pins a
 * refusal that holds; a test that fails shows a real gap.
 */
let database: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await startTestApp(database.url);
}, 60_000);

afterAll(async () => {
  await app.close();
  await database.drop();
});

interface Reply {
  status: number;
  text: string;
  body: Record<string, unknown>;
  headers: Headers;
}

async function send(
  method: string,
  path: string,
  options: {
    authorization?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Reply> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    headers: response.headers,
  };
}

function bearer(key: string): string {
  return `Bearer ${key}`;
}

async function countOf(sql: string, params: unknown[]): Promise<number> {
  const rows = (await database.orm.em.getConnection().execute(sql, params)) as Array<{
    count: string;
  }>;
  return Number(required(rows[0]?.count, 'a count row'));
}

function betFor(
  providerId: string,
  externalTransactionId: string,
  walletId: string,
  playerId: string,
) {
  return {
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '5.00', currency: 'BRL' },
  };
}

describe('adversarial authorization', () => {
  let operatorKey: string;
  let providerAKey: string;
  let providerBKey: string;
  let walletId: string;
  let playerId: string;
  let transactionOfA: string;
  let externalIdOfA: string;

  beforeAll(async () => {
    operatorKey = (await app.createApiClient({ name: 'ops', role: 'OPERATOR' })).apiKey;
    providerAKey = (
      await app.createApiClient({ name: 'provider a', role: 'PROVIDER', providerId: 'provider-a' })
    ).apiKey;
    providerBKey = (
      await app.createApiClient({ name: 'provider b', role: 'PROVIDER', providerId: 'provider-b' })
    ).apiKey;
    playerId = randomUUID();
    const wallet = await send('POST', '/wallets', {
      authorization: bearer(operatorKey),
      body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
    });
    walletId = required(wallet.body.id as string | undefined, 'the wallet id');
    externalIdOfA = `adv-${randomUUID()}`;
    const submitted = await send('POST', '/wagering/transactions', {
      authorization: bearer(providerAKey),
      headers: { 'idempotency-key': `provider-a:${externalIdOfA}` },
      body: betFor('provider-a', externalIdOfA, walletId, playerId),
    });
    transactionOfA = required(submitted.body.transactionId as string | undefined, 'a transaction');
  });

  describe('a provider key cannot reach operator routes by another spelling', () => {
    const operatorOnly = [
      { method: 'GET', path: '/wallets/' },
      { method: 'GET', path: `/wallets/${randomUUID()}/` },
      { method: 'GET', path: `/wallets/${randomUUID()}/ledger/` },
      { method: 'GET', path: '/metrics/' },
      { method: 'GET', path: '/metrics?format=json' },
      { method: 'HEAD', path: '/metrics' },
      { method: 'GET', path: '/Metrics' },
      { method: 'GET', path: '/wallets/%2e%2e/metrics' },
    ];

    for (const { method, path } of operatorOnly) {
      test(`${method} ${path} is not answered with operator data for a provider key`, async () => {
        const reply = await send(method, path, { authorization: bearer(providerAKey) });

        expect(reply.status).not.toBe(200);
        expect(reply.text).not.toContain('"counters"');
        expect(reply.text).not.toContain('"balance"');
      });
    }

    test('POST /wallets/ with a provider key is 403 and opens nothing', async () => {
      const before = await countOf('SELECT count(*)::text AS count FROM wallets', []);
      const reply = await send('POST', '/wallets/', {
        authorization: bearer(providerAKey),
        body: { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' } },
      });

      expect(reply.status).toBe(403);
      expect(await countOf('SELECT count(*)::text AS count FROM wallets', [])).toBe(before);
    });

    test('reconciliation and the ledger are refused to a provider key before any lookup', async () => {
      const unknownWallet = randomUUID();
      const ledger = await send('GET', `/wallets/${unknownWallet}/ledger`, {
        authorization: bearer(providerAKey),
      });
      const reconcile = await send('POST', `/wallets/${unknownWallet}/reconciliation`, {
        authorization: bearer(providerAKey),
        body: {},
      });

      expect(ledger.status).toBe(403);
      expect(reconcile.status).toBe(403);
    });
  });

  describe('no existence oracle for wallets', () => {
    test('an existing and a missing wallet look the same to a provider key: both 403', async () => {
      const existing = await send('GET', `/wallets/${walletId}`, {
        authorization: bearer(providerAKey),
      });
      const missing = await send('GET', `/wallets/${randomUUID()}`, {
        authorization: bearer(providerAKey),
      });

      expect(existing.status).toBe(403);
      expect(missing.status).toBe(403);
      expect(missing.text).toBe(existing.text.replaceAll(walletId, '<id>'));
    });
  });

  describe('transactions of another provider', () => {
    test('another provider gets 403 for the id, and the body carries none of the transaction', async () => {
      const reply = await send('GET', `/wagering/transactions/${transactionOfA}`, {
        authorization: bearer(providerBKey),
      });

      expect(reply.status).toBe(403);
      for (const leaked of [externalIdOfA, 'provider-a', walletId, playerId, 'PROCESSED', 'BET']) {
        expect(reply.text).not.toContain(leaked);
      }
    });

    test('a missing transaction id is 404 for a provider, which is the only other answer it can get', async () => {
      const reply = await send('GET', `/wagering/transactions/${randomUUID()}`, {
        authorization: bearer(providerBKey),
      });

      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ error: { code: 'TRANSACTION_NOT_FOUND' } });
    });

    test('a malformed transaction id is 400 before any lookup, for every caller', async () => {
      for (const key of [providerAKey, providerBKey, operatorKey]) {
        const reply = await send('GET', '/wagering/transactions/not-a-uuid', {
          authorization: bearer(key),
        });
        expect(reply.status).toBe(400);
      }
    });

    test("another provider's external id, under its own provider path, is 403 and reveals no fields", async () => {
      const reply = await send(
        'GET',
        `/providers/provider-a/wagering/transactions/${externalIdOfA}`,
        { authorization: bearer(providerBKey) },
      );

      expect(reply.status).toBe(403);
      expect(reply.text).not.toContain(transactionOfA);
    });

    test("a provider's own path with a missing external id is 404, not 403", async () => {
      const reply = await send(
        'GET',
        `/providers/provider-b/wagering/transactions/missing-${randomUUID()}`,
        { authorization: bearer(providerBKey) },
      );

      expect(reply.status).toBe(404);
    });
  });

  describe('a submission cannot write under another provider', () => {
    test('a key that names another provider in its Idempotency-Key writes under the caller only', async () => {
      const externalTransactionId = `rekey-${randomUUID()}`;
      const submitted = await send('POST', '/wagering/transactions', {
        authorization: bearer(providerAKey),
        headers: { 'idempotency-key': `provider-b:${externalTransactionId}` },
        body: betFor('provider-a', externalTransactionId, walletId, playerId),
      });

      expect(submitted.status).toBe(201);
      const asB = await send(
        'GET',
        `/providers/provider-b/wagering/transactions/${externalTransactionId}`,
        { authorization: bearer(providerBKey) },
      );
      expect(asB.status).toBe(404);
    });

    test('a provider whose body names another provider writes nothing, even with a valid key', async () => {
      const externalTransactionId = `spoof-${randomUUID()}`;
      const reply = await send('POST', '/wagering/transactions', {
        authorization: bearer(providerAKey),
        headers: { 'idempotency-key': `provider-b:${externalTransactionId}` },
        body: betFor('provider-b', externalTransactionId, walletId, playerId),
      });

      expect(reply.status).toBe(403);
      expect(
        await countOf(
          'SELECT count(*)::text AS count FROM wager_transactions WHERE external_transaction_id = ?',
          [externalTransactionId],
        ),
      ).toBe(0);
    });
  });

  describe('the Authorization header', () => {
    test('the scheme is case-insensitive, as RFC 9110 defines it', async () => {
      const reply = await send('GET', `/wallets/${walletId}`, {
        authorization: `bearer ${operatorKey}`,
      });

      expect(reply.status).toBe(200);
    });

    for (const [label, value] of [
      ['a double space after the scheme', `Bearer  ${'x'}`],
      ['the Basic scheme', 'Basic dXNlcjpwYXNz'],
      ['a token followed by a second word', 'Bearer abc def'],
      ['no scheme', 'abc'],
      ['an empty token', 'Bearer '],
    ] as const) {
      test(`${label} is 401`, async () => {
        const reply = await send('GET', '/metrics', { authorization: value });

        expect(reply.status).toBe(401);
        expect(reply.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      });
    }

    test('a key in the query string is not an authentication', async () => {
      const reply = await send('GET', `/metrics?api_key=${operatorKey}`);

      expect(reply.status).toBe(401);
    });

    test('a refused key is never echoed back, in the body or the headers', async () => {
      const unknown = `wgr_${randomUUID()}`;
      const reply = await send('GET', '/metrics', { authorization: bearer(unknown) });

      expect(reply.status).toBe(401);
      expect(reply.text).not.toContain(unknown);
      for (const value of reply.headers.values()) {
        expect(value).not.toContain(unknown);
      }
    });
  });

  describe('revocation of a provider key', () => {
    test('a provider key stops working on the next request after it is revoked', async () => {
      const created = await app.createApiClient({
        name: 'short lived',
        role: 'PROVIDER',
        providerId: 'provider-c',
      });
      const before = await send('GET', `/wagering/transactions/${transactionOfA}`, {
        authorization: bearer(created.apiKey),
      });
      expect(before.status).toBe(403);

      await app.revokeApiClient(created.clientId);
      const after = await send('GET', `/wagering/transactions/${transactionOfA}`, {
        authorization: bearer(created.apiKey),
      });
      expect(after.status).toBe(401);
    });
  });

  test('the public health probes answer with an invalid key, and do not reflect it', async () => {
    const unknown = `wgr_${randomUUID()}`;
    const reply = await send('GET', '/health/live', { authorization: bearer(unknown) });

    expect(reply.status).toBe(200);
    expect(reply.text).not.toContain(unknown);
  });
});
