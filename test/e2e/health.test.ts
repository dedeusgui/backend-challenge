import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

async function get(
  baseUrl: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('health', () => {
  test('liveness is 200 and does not depend on any dependency', async () => {
    const result = await get(app.baseUrl, '/health/live');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'ok' });
  });

  test('readiness is 200 only after PostgreSQL and the command queue answer', async () => {
    const result = await get(app.baseUrl, '/health/ready');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'ok', checks: { database: 'up', sqs: 'up' } });
  });

  test('readiness is 503 and names the failing dependency when SQS is unreachable', async () => {
    const unreachable = await startTestApp(database.url, { sqsEndpoint: 'http://127.0.0.1:1' });
    try {
      const result = await get(unreachable.baseUrl, '/health/ready');

      expect(result.status).toBe(503);
      expect(result.body).toEqual({
        status: 'unavailable',
        checks: { database: 'up', sqs: 'down' },
      });
    } finally {
      await unreachable.close();
    }
  });

  test('readiness is 503 and names the failing dependency when PostgreSQL is unreachable', async () => {
    const unreachable = await startTestApp('postgresql://postgres:postgres@127.0.0.1:1/postgres');
    try {
      const result = await get(unreachable.baseUrl, '/health/ready');

      expect(result.status).toBe(503);
      expect(result.body).toEqual({
        status: 'unavailable',
        checks: { database: 'down', sqs: 'up' },
      });
    } finally {
      await unreachable.close();
    }
  });
});
