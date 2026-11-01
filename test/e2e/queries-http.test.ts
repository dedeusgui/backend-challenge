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

/** Money is always `{ amount, currency }` on the wire. Extracts the decimal string from it. */
function amountOf(money: unknown): string {
  return (money as { amount: string }).amount;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
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

async function fundedWallet(amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = randomUUID();
  const created = await call('POST', '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  return { walletId: created.body.id as string, playerId };
}

async function submit(
  wallet: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  externalTransactionId: string,
  reference?: string,
): Promise<HttpResult> {
  return call(
    'POST',
    '/wagering/transactions',
    {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
    },
    { 'idempotency-key': `provider-a:${externalTransactionId}` },
  );
}

/** Wallets and metrics are for the operator. Wagering and provider lookups are for provider-a. */
function authFor(path: string): Record<string, string> {
  const key =
    path.startsWith('/wagering') || path.startsWith('/providers') ? providerKey : operatorKey;
  return { authorization: `Bearer ${key}` };
}

describe('wallet queries', () => {
  test('GET /wallets/:id returns the balance, version and currency', async () => {
    const wallet = await fundedWallet('100.00');

    const result = await call('GET', `/wallets/${wallet.walletId}`);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      id: wallet.walletId,
      playerId: wallet.playerId,
      balance: { amount: '100.00', currency: 'BRL' },
      version: 1,
    });
  });

  test('GET /wallets/:id for an unknown wallet is 404 WALLET_NOT_FOUND', async () => {
    const result = await call('GET', `/wallets/${randomUUID()}`);

    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'WALLET_NOT_FOUND' } });
  });

  test('the ledger is listed in order and paginated with an opaque cursor', async () => {
    const wallet = await fundedWallet('100.00');
    const bet = `l-${randomUUID()}`;
    await submit(wallet, 'BET', '10.00', bet);
    await submit(wallet, 'WIN', '4.00', `l-${randomUUID()}`, bet);

    const first = await call('GET', `/wallets/${wallet.walletId}/ledger?limit=2`);
    const cursor = first.body.nextCursor as string;
    const second = await call(
      'GET',
      `/wallets/${wallet.walletId}/ledger?limit=2&cursor=${encodeURIComponent(cursor)}`,
    );

    expect(first.status).toBe(200);
    const entries = [
      ...(first.body.entries as Array<Record<string, unknown>>),
      ...(second.body.entries as Array<Record<string, unknown>>),
    ];
    expect(
      entries.map((entry) => [
        entry.direction,
        amountOf(entry.amount),
        amountOf(entry.balanceAfter),
      ]),
    ).toEqual([
      ['CREDIT', '100.00', '100.00'],
      ['DEBIT', '10.00', '90.00'],
      ['CREDIT', '4.00', '94.00'],
    ]);
    expect(second.body.nextCursor).toBeNull();
  });

  test('a malformed cursor is 400 INVALID_CURSOR', async () => {
    const wallet = await fundedWallet('1.00');

    const result = await call('GET', `/wallets/${wallet.walletId}/ledger?cursor=not-a-cursor`);

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
  });
});

describe('transaction lookups', () => {
  test('GET /wagering/transactions/:id returns the transaction with its status and failure code', async () => {
    const wallet = await fundedWallet('10.00');
    const externalTransactionId = `t-${randomUUID()}`;
    const submitted = await submit(wallet, 'BET', '25.00', externalTransactionId);

    const result = await call(
      'GET',
      `/wagering/transactions/${submitted.body.transactionId as string}`,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      transactionId: submitted.body.transactionId,
      externalTransactionId,
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_BALANCE',
      kind: 'BET',
    });
  });

  test('GET /providers/:p/wagering/transactions/:e finds the same transaction by external id', async () => {
    const wallet = await fundedWallet('100.00');
    const externalTransactionId = `t-${randomUUID()}`;
    const submitted = await submit(wallet, 'BET', '25.00', externalTransactionId);

    const result = await call(
      'GET',
      `/providers/provider-a/wagering/transactions/${externalTransactionId}`,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      transactionId: submitted.body.transactionId,
      status: 'PROCESSED',
    });
  });

  test('unknown transactions are 404 for both lookups', async () => {
    const byId = await call('GET', `/wagering/transactions/${randomUUID()}`);
    const byExternal = await call(
      'GET',
      `/providers/provider-a/wagering/transactions/nope-${randomUUID()}`,
    );

    expect(byId.status).toBe(404);
    expect(byId.body).toMatchObject({ error: { code: 'TRANSACTION_NOT_FOUND' } });
    expect(byExternal.status).toBe(404);
  });
});

describe('reconciliation', () => {
  test('a consistent wallet reconciles with zero difference', async () => {
    const wallet = await fundedWallet('100.00');
    await submit(wallet, 'BET', '30.00', `r-${randomUUID()}`);

    const result = await call('POST', `/wallets/${wallet.walletId}/reconciliation`);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      walletId: wallet.walletId,
      storedBalance: { amount: '70.00', currency: 'BRL' },
      calculatedBalance: { amount: '70.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('a divergence is reported, counted, and not silently corrected', async () => {
    const wallet = await fundedWallet('100.00');
    // The balance trigger refuses a balance that differs from its ledger, so the divergence is injected the way a
    // manual correction outside the application would be: in one transaction with the triggers off for that
    // transaction only. Reconciliation must still report it, because the database refuses it only when triggers run.
    await database.orm.em.fork().transactional(async (em) => {
      await em.execute("SET LOCAL session_replication_role = 'replica'");
      await em.execute(
        `UPDATE wallets SET balance = balance + 1, version = version + 1 WHERE id = ?`,
        [wallet.walletId],
      );
    });

    const result = await call('POST', `/wallets/${wallet.walletId}/reconciliation`);
    const after = await call('GET', `/wallets/${wallet.walletId}`);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      consistent: false,
      difference: { amount: '1.00', currency: 'BRL' },
    });
    expect(after.body.balance).toEqual({ amount: '101.00', currency: 'BRL' });
    const metrics = (await (
      await fetch(`${app.baseUrl}/metrics`, { headers: authFor('/metrics') })
    ).json()) as {
      counters: Record<string, number>;
    };
    expect(metrics.counters['reconciliation_divergences_total']).toBeGreaterThanOrEqual(1);
    // The divergence was injected on purpose. Restore it so the database-wide invariant holds at teardown.
    await database.orm.em
      .getConnection()
      .execute(`UPDATE wallets SET balance = balance - 1, version = version + 1 WHERE id = ?`, [
        wallet.walletId,
      ]);
  });
});
