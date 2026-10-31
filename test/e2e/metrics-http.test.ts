import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { startTestApp, type TestApp } from './support/test-app';

let database: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await startTestApp(database.url);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('GET /metrics', () => {
  test('counts processed transactions and idempotent replays of this process', async () => {
    const playerId = randomUUID();
    const wallet = (await (
      await fetch(`${app.baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
      })
    ).json()) as { id: string };
    const externalTransactionId = `m-${randomUUID()}`;
    const body = JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '5.00', currency: 'BRL' },
    });
    const headers = {
      'content-type': 'application/json',
      'idempotency-key': `provider-a:${externalTransactionId}`,
    };
    await fetch(`${app.baseUrl}/wagering/transactions`, { method: 'POST', headers, body });
    await fetch(`${app.baseUrl}/wagering/transactions`, { method: 'POST', headers, body });

    const metrics = (await (await fetch(`${app.baseUrl}/metrics`)).json()) as {
      counters: Record<string, number>;
      summaries: Record<string, { count: number }>;
    };

    // One new transaction and one replay of it: the replay must not be counted as a transaction.
    expect(metrics.counters['transactions_total{status="PROCESSED"}']).toBe(1);
    expect(metrics.counters['idempotent_replays_total']).toBe(1);
    // Latency is timed for every request, the replay included, so the count is the number of requests.
    expect(metrics.summaries['processing_latency_ms']?.count).toBe(2);
  });
});
