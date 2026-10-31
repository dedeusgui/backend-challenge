import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { startTestApp, type TestApp } from './support/test-app';
import { contractErrors } from '../support/json-schema-subset';
import { loadOpenApi, type OpenApiDocument } from '../support/openapi-document';
import { required } from '../support/required';

/**
 * The real answers of the running API, checked against docs/openapi.json. Each call must return a status the
 * document lists for that operation, and a body that validates against that status's schema. A divergence
 * fails here with the JSON path at which it occurs.
 */

let database: TestDatabase;
let app: TestApp;
let document: OpenApiDocument;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await startTestApp(database.url);
  document = await loadOpenApi();
}, 60_000);

afterAll(async () => {
  await app.close();
  await database.drop();
});

interface Reply {
  status: number;
  text: string;
  body: unknown;
}

async function send(
  method: string,
  path: string,
  options: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
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
  return { status: response.status, text, body: text === '' ? undefined : JSON.parse(text) };
}

/** The status must be documented for the operation, and the body must validate against its schema. */
function expectContract(method: string, template: string, reply: Reply): void {
  const operation = document.paths[template]?.[method.toLowerCase()];
  if (operation === undefined) {
    throw new Error(`${method} ${template} is not in docs/openapi.json`);
  }
  const response = operation.responses[String(reply.status)];
  expect({
    operation: `${method} ${template}`,
    status: reply.status,
    documented: response !== undefined,
  }).toEqual({
    operation: `${method} ${template}`,
    status: reply.status,
    documented: true,
  });
  const schema = response?.content?.['application/json']?.schema;
  if (schema === undefined) {
    return;
  }
  expect({
    at: `${method} ${template} ${reply.status}`,
    errors: contractErrors(reply.body, schema, document),
  }).toEqual({
    at: `${method} ${template} ${reply.status}`,
    errors: [],
  });
}

describe('the API answers what docs/openapi.json documents', () => {
  let operatorKey: string;
  let providerAKey: string;
  let providerBKey: string;
  let walletId: string;
  let playerId: string;

  beforeAll(async () => {
    operatorKey = (await app.createApiClient({ name: 'ops', role: 'OPERATOR' })).apiKey;
    providerAKey = (
      await app.createApiClient({ name: 'a', role: 'PROVIDER', providerId: 'provider-a' })
    ).apiKey;
    providerBKey = (
      await app.createApiClient({ name: 'b', role: 'PROVIDER', providerId: 'provider-b' })
    ).apiKey;
  });

  test('health: liveness and readiness', async () => {
    const live = await send('GET', '/health/live');
    const ready = await send('GET', '/health/ready');
    expectContract('GET', '/health/live', live);
    expectContract('GET', '/health/ready', ready);
    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
  });

  test('wallets: open (201), duplicate (409), malformed money (400), provider (403), oversize (413)', async () => {
    playerId = randomUUID();
    const opened = await send('POST', '/wallets', {
      key: operatorKey,
      body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
    });
    expectContract('POST', '/wallets', opened);
    expect(opened.status).toBe(201);
    walletId = required((opened.body as { id?: string }).id, 'the opened wallet id');

    const duplicate = await send('POST', '/wallets', {
      key: operatorKey,
      body: { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } },
    });
    expectContract('POST', '/wallets', duplicate);
    expect(duplicate.status).toBe(409);

    const malformed = await send('POST', '/wallets', {
      key: operatorKey,
      body: { playerId: randomUUID(), initialBalance: { amount: '1', currency: 'BRL' } },
    });
    expectContract('POST', '/wallets', malformed);
    expect(malformed.status).toBe(400);

    const forbidden = await send('POST', '/wallets', {
      key: providerAKey,
      body: { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' } },
    });
    expectContract('POST', '/wallets', forbidden);
    expect(forbidden.status).toBe(403);

    const oversize = await send('POST', '/wallets', {
      key: operatorKey,
      body: { playerId: randomUUID(), padding: 'x'.repeat(17_000) },
    });
    expectContract('POST', '/wallets', oversize);
    expect(oversize.status).toBe(413);
  });

  test('wallets: read (200, 400, 404, 403), ledger (200, 400), reconciliation (200)', async () => {
    const read = await send('GET', `/wallets/${walletId}`, { key: operatorKey });
    expectContract('GET', '/wallets/{walletId}', read);
    expect(read.status).toBe(200);

    expectContract(
      'GET',
      '/wallets/{walletId}',
      await send('GET', '/wallets/not-a-uuid', { key: operatorKey }),
    );
    expectContract(
      'GET',
      '/wallets/{walletId}',
      await send('GET', `/wallets/${randomUUID()}`, { key: operatorKey }),
    );
    expectContract(
      'GET',
      '/wallets/{walletId}',
      await send('GET', `/wallets/${walletId}`, { key: providerAKey }),
    );

    const ledger = await send('GET', `/wallets/${walletId}/ledger?limit=10`, { key: operatorKey });
    expectContract('GET', '/wallets/{walletId}/ledger', ledger);
    expect(ledger.status).toBe(200);
    expectContract(
      'GET',
      '/wallets/{walletId}/ledger',
      await send('GET', `/wallets/${walletId}/ledger?cursor=zzz`, { key: operatorKey }),
    );

    const reconciled = await send('POST', `/wallets/${walletId}/reconciliation`, {
      key: operatorKey,
    });
    expectContract('POST', '/wallets/{walletId}/reconciliation', reconciled);
    expect(reconciled.status).toBe(200);
  });

  test('wagering: applied (201), replay (200), rejected (422), pending reference (202), 400, 404, 409', async () => {
    const bet = (
      externalTransactionId: string,
      amount: string,
      kind = 'BET',
      reference?: string,
    ) => ({
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
    });
    const key = (externalTransactionId: string) => ({
      'idempotency-key': `provider-a:${externalTransactionId}`,
    });
    const path = '/wagering/transactions';

    const applied = await send('POST', path, {
      key: providerAKey,
      headers: key('bet-1'),
      body: bet('bet-1', '25.00'),
    });
    expectContract('POST', path, applied);
    expect(applied.status).toBe(201);

    const replay = await send('POST', path, {
      key: providerAKey,
      headers: key('bet-1'),
      body: bet('bet-1', '25.00'),
    });
    expectContract('POST', path, replay);
    expect(replay.status).toBe(200);

    const rejected = await send('POST', path, {
      key: providerAKey,
      headers: key('bet-big'),
      body: bet('bet-big', '500.00'),
    });
    expectContract('POST', path, rejected);
    expect(rejected.status).toBe(422);

    const pending = await send('POST', path, {
      key: providerAKey,
      headers: key('refund-early'),
      body: bet('refund-early', '10.00', 'REFUND', 'bet-not-yet-here'),
    });
    expectContract('POST', path, pending);
    expect(pending.status).toBe(202);

    expectContract(
      'POST',
      path,
      await send('POST', path, { key: providerAKey, body: bet('no-key', '1.00') }),
    );
    expectContract(
      'POST',
      path,
      await send('POST', path, {
        key: providerAKey,
        headers: key('ghost'),
        body: { ...bet('ghost', '1.00'), walletId: randomUUID() },
      }),
    );
    expectContract(
      'POST',
      path,
      await send('POST', path, {
        key: providerAKey,
        headers: key('bet-1'),
        body: bet('bet-1', '99.00'),
      }),
    );
  });

  test('wagering: a transaction by id (200, 404, 403) and by provider path (200, 404)', async () => {
    const submitted = await send('POST', '/wagering/transactions', {
      key: providerAKey,
      headers: { 'idempotency-key': 'provider-a:read-me' },
      body: {
        providerId: 'provider-a',
        externalTransactionId: 'read-me',
        playerId,
        walletId,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
    });
    const transactionId = required(
      (submitted.body as { transactionId?: string }).transactionId,
      'a transaction id',
    );

    const byId = await send('GET', `/wagering/transactions/${transactionId}`, {
      key: providerAKey,
    });
    expectContract('GET', '/wagering/transactions/{transactionId}', byId);
    expect(byId.status).toBe(200);
    expectContract(
      'GET',
      '/wagering/transactions/{transactionId}',
      await send('GET', `/wagering/transactions/${randomUUID()}`, { key: providerAKey }),
    );
    expectContract(
      'GET',
      '/wagering/transactions/{transactionId}',
      await send('GET', `/wagering/transactions/${transactionId}`, { key: providerBKey }),
    );

    const byProvider = await send('GET', '/providers/provider-a/wagering/transactions/read-me', {
      key: providerAKey,
    });
    expectContract(
      'GET',
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
      byProvider,
    );
    expect(byProvider.status).toBe(200);
    expectContract(
      'GET',
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
      await send('GET', '/providers/provider-a/wagering/transactions/missing', {
        key: providerAKey,
      }),
    );
  });

  test('metrics: operator (200), no key (401), provider (403)', async () => {
    const metrics = await send('GET', '/metrics', { key: operatorKey });
    expectContract('GET', '/metrics', metrics);
    expect(metrics.status).toBe(200);
    expectContract('GET', '/metrics', await send('GET', '/metrics'));
    expectContract('GET', '/metrics', await send('GET', '/metrics', { key: providerAKey }));
  });
});
