import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { startTestApp, type TestApp } from './support/test-app';

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

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...authFor(path), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function createWallet(
  initialAmount: string,
): Promise<{ walletId: string; playerId: string }> {
  const playerId = randomUUID();
  const created = await request('POST', '/wallets', {
    playerId,
    initialBalance: { amount: initialAmount, currency: 'BRL' },
  });
  expect(created.status).toBe(201);
  return { walletId: created.body.id as string, playerId };
}

function betBody(
  wallet: { walletId: string; playerId: string },
  externalTransactionId: string,
  amount: string,
) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

function idempotencyKey(externalTransactionId: string): Record<string, string> {
  return { 'idempotency-key': `provider-a:${externalTransactionId}` };
}

/** Wallets and metrics are for the operator. Wagering and provider lookups are for provider-a. */
function authFor(path: string): Record<string, string> {
  const key =
    path.startsWith('/wagering') || path.startsWith('/providers') ? providerKey : operatorKey;
  return { authorization: `Bearer ${key}` };
}

describe('POST /wallets', () => {
  test('creates a funded wallet and returns 201 with its balance and version', async () => {
    const playerId = randomUUID();

    const result = await request('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  test('a second wallet for the same player and currency is 409 WALLET_ALREADY_EXISTS', async () => {
    const playerId = randomUUID();
    await request('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });

    const result = await request('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: 'WALLET_ALREADY_EXISTS' } });
  });

  test('a malformed amount is 400 with the stable money code', async () => {
    const result = await request('POST', '/wallets', {
      playerId: randomUUID(),
      initialBalance: { amount: '25.123', currency: 'BRL' },
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'INVALID_MONEY' } });
  });

  test('an unknown field is 400 INVALID_REQUEST, so contract drift is visible', async () => {
    const result = await request('POST', '/wallets', {
      playerId: randomUUID(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
      nickname: 'extra',
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });
});

describe('POST /wagering/transactions', () => {
  test('a BET is 201 PROCESSED with the new balance, and an identical retry is 200 with idempotentReplay', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = `transaction-${randomUUID()}`;

    const first = await request(
      'POST',
      '/wagering/transactions',
      betBody(wallet, externalTransactionId, '25.00'),
      idempotencyKey(externalTransactionId),
    );
    const replay = await request(
      'POST',
      '/wagering/transactions',
      betBody(wallet, externalTransactionId, '25.00'),
      idempotencyKey(externalTransactionId),
    );

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      transactionId: first.body.transactionId,
      idempotentReplay: true,
      balance: { amount: '75.00', currency: 'BRL' },
    });
  });

  test('a BET the balance cannot cover is 422 REJECTED with the failure code', async () => {
    const wallet = await createWallet('10.00');
    const externalTransactionId = `transaction-${randomUUID()}`;

    const result = await request(
      'POST',
      '/wagering/transactions',
      betBody(wallet, externalTransactionId, '25.00'),
      idempotencyKey(externalTransactionId),
    );

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' });
  });

  test('a REFUND that arrives before its BET is 202 PENDING_REFERENCE', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = `refund-${randomUUID()}`;

    const result = await request(
      'POST',
      '/wagering/transactions',
      {
        ...betBody(wallet, externalTransactionId, '25.00'),
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-not-yet',
      },
      idempotencyKey(externalTransactionId),
    );

    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ status: 'PENDING_REFERENCE' });
  });

  test('a missing Idempotency-Key is 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const wallet = await createWallet('100.00');

    const result = await request(
      'POST',
      '/wagering/transactions',
      betBody(wallet, `t-${randomUUID()}`, '25.00'),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
  });

  test('the same key with a different payload is 409 IDEMPOTENCY_CONFLICT', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = `transaction-${randomUUID()}`;
    await request(
      'POST',
      '/wagering/transactions',
      betBody(wallet, externalTransactionId, '25.00'),
      idempotencyKey(externalTransactionId),
    );

    const result = await request(
      'POST',
      '/wagering/transactions',
      betBody(wallet, externalTransactionId, '30.00'),
      idempotencyKey(externalTransactionId),
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  test('OPENING submitted by a provider is 400 INVALID_TRANSACTION', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = `open-${randomUUID()}`;

    const result = await request(
      'POST',
      '/wagering/transactions',
      { ...betBody(wallet, externalTransactionId, '1.00'), kind: 'OPENING' },
      idempotencyKey(externalTransactionId),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'INVALID_TRANSACTION' } });
  });

  test('an unknown wallet is 404 WALLET_NOT_FOUND', async () => {
    const externalTransactionId = `transaction-${randomUUID()}`;
    const body = {
      ...betBody({ walletId: randomUUID(), playerId: 'nobody' }, externalTransactionId, '1.00'),
    };

    const result = await request(
      'POST',
      '/wagering/transactions',
      body,
      idempotencyKey(externalTransactionId),
    );

    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'WALLET_NOT_FOUND' } });
  });
});
