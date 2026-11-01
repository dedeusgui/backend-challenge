import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

describe('GET /metrics/prometheus', () => {
  test('returns Prometheus text to an operator', async () => {
    const response = await fetch(`${app.baseUrl}/metrics/prometheus`, {
      headers: { authorization: `Bearer ${operatorKey}` },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/plain');
    expect(response.headers.get('content-type')).toContain('version=0.0.4');
    expect(body).toContain('# TYPE');
    expect(body).toMatch(/^# TYPE auth_ms summary$/m);
    expect(body).toMatch(/^auth_ms_count 1$/m);
  });

  test('requires an operator key', async () => {
    const response = await fetch(`${app.baseUrl}/metrics/prometheus`);

    expect(response.status).toBe(401);
  });

  test('rejects a provider key', async () => {
    const response = await fetch(`${app.baseUrl}/metrics/prometheus`, {
      headers: { authorization: `Bearer ${providerKey}` },
    });

    expect(response.status).toBe(403);
  });
});
