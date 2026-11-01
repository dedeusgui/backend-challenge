import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { startTestApp, type TestApp } from './support/test-app';
import { required } from '../support/required';

/**
 * Who may call what. Health is public. Wallets and metrics are for operators. A provider key
 * works only for its own provider id, and a request for another provider is refused before anything
 * is written. Keys are sent as bearer tokens.
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

async function call(
  method: string,
  path: string,
  options: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.key === undefined ? {} : { authorization: `Bearer ${options.key}` }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    headers: response.headers,
  };
}

async function countOf(sql: string, params: unknown[]): Promise<string> {
  const rows = (await database.orm.em.getConnection().execute(sql, params)) as Array<{
    count: string;
  }>;
  return required(rows[0]?.count, 'a count row');
}

describe('API key authentication', () => {
  let operatorKey: string;
  let providerAKey: string;
  let providerBKey: string;
  let revokedKey: string;

  beforeAll(async () => {
    operatorKey = (await app.createApiClient({ name: 'ops', role: 'OPERATOR' })).apiKey;
    providerAKey = (
      await app.createApiClient({ name: 'provider a', role: 'PROVIDER', providerId: 'provider-a' })
    ).apiKey;
    providerBKey = (
      await app.createApiClient({ name: 'provider b', role: 'PROVIDER', providerId: 'provider-b' })
    ).apiKey;
    const retired = await app.createApiClient({ name: 'retired', role: 'OPERATOR' });
    await app.revokeApiClient(retired.clientId);
    revokedKey = retired.apiKey;
  });

  test('health stays public: liveness and readiness answer without a key', async () => {
    expect((await call('GET', '/health/live')).status).toBe(200);
    expect((await call('GET', '/health/ready')).status).toBe(200);
  });

  test('a request without a key is 401 UNAUTHENTICATED, with a Bearer challenge', async () => {
    const result = await call('POST', '/wallets', { body: {} });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(result.headers.get('www-authenticate')).toBe('Bearer');
  });

  test('an unknown key and a revoked key are both 401', async () => {
    expect((await call('GET', '/metrics', { key: `wgr_${randomUUID()}` })).status).toBe(401);
    expect((await call('GET', '/metrics', { key: revokedKey })).status).toBe(401);
  });

  test('a provider key cannot open a wallet or read metrics: 403 FORBIDDEN', async () => {
    const opened = await call('POST', '/wallets', {
      key: providerAKey,
      body: { playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } },
    });
    const metrics = await call('GET', '/metrics', { key: providerAKey });

    expect(opened.status).toBe(403);
    expect(opened.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(metrics.status).toBe(403);
  });

  test('an operator key opens a wallet and reads metrics', async () => {
    const opened = await call('POST', '/wallets', {
      key: operatorKey,
      body: { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    });

    expect(opened.status).toBe(201);
    expect((await call('GET', '/metrics', { key: operatorKey })).status).toBe(200);
  });

  test('a provider submits for its own provider id', async () => {
    const wallet = await call('POST', '/wallets', {
      key: operatorKey,
      body: { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    });
    const walletId = wallet.body.id as string;
    const playerId = (wallet.body as { playerId: string }).playerId;

    const submitted = await call('POST', '/wagering/transactions', {
      key: providerAKey,
      headers: { 'idempotency-key': `provider-a:own-${randomUUID()}` },
      body: bet('provider-a', `own-${randomUUID()}`, walletId, playerId, '25.00'),
    });

    expect(submitted.status).toBe(201);
  });

  test('a provider submitting for another provider id is 403, and nothing is written', async () => {
    const wallet = await call('POST', '/wallets', {
      key: operatorKey,
      body: { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    });
    const walletId = wallet.body.id as string;
    const playerId = (wallet.body as { playerId: string }).playerId;
    const externalTransactionId = `foreign-${randomUUID()}`;

    const submitted = await call('POST', '/wagering/transactions', {
      key: providerAKey,
      headers: { 'idempotency-key': `provider-b:${externalTransactionId}` },
      body: bet('provider-b', externalTransactionId, walletId, playerId, '25.00'),
    });

    expect(submitted.status).toBe(403);
    expect(submitted.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(
      await countOf(
        `SELECT count(*)::text AS count FROM wager_transactions WHERE external_transaction_id = ?`,
        [externalTransactionId],
      ),
    ).toBe('0');
  });

  test('a provider reads its own transactions, and another provider is refused by id and by provider path', async () => {
    const wallet = await call('POST', '/wallets', {
      key: operatorKey,
      body: { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    });
    const walletId = wallet.body.id as string;
    const playerId = (wallet.body as { playerId: string }).playerId;
    const externalTransactionId = `read-${randomUUID()}`;
    const submitted = await call('POST', '/wagering/transactions', {
      key: providerAKey,
      headers: { 'idempotency-key': `provider-a:${externalTransactionId}` },
      body: bet('provider-a', externalTransactionId, walletId, playerId, '25.00'),
    });
    const transactionId = submitted.body.transactionId as string;

    expect(
      (await call('GET', `/wagering/transactions/${transactionId}`, { key: providerAKey })).status,
    ).toBe(200);
    // By id, another provider gets the answer of a missing transaction (see the adversarial suite).
    const otherProvider = await call('GET', `/wagering/transactions/${transactionId}`, {
      key: providerBKey,
    });
    expect(otherProvider.status).toBe(404);
    expect(otherProvider.body).toMatchObject({ error: { code: 'TRANSACTION_NOT_FOUND' } });
    expect(
      (
        await call('GET', `/providers/provider-a/wagering/transactions/${externalTransactionId}`, {
          key: providerBKey,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('GET', `/providers/provider-a/wagering/transactions/${externalTransactionId}`, {
          key: providerAKey,
        })
      ).status,
    ).toBe(200);
  });
});

function bet(
  providerId: string,
  externalTransactionId: string,
  walletId: string,
  playerId: string,
  amount: string,
) {
  return {
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}
