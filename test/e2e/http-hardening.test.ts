import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { startTestApp, type TestApp } from './support/test-app';

/**
 * Every response carries the same few headers. The framework's own identity header is removed, the
 * content type is not sniffed, and a response is never kept by a shared cache.
 */

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

describe('HTTP response hardening', () => {
  test('a public response does not name the framework', async () => {
    const response = await fetch(`${app.baseUrl}/health/live`);
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  test('a response is not sniffed and is not stored by a shared cache', async () => {
    const response = await fetch(`${app.baseUrl}/health/live`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('an error response carries the same headers', async () => {
    const response = await fetch(`${app.baseUrl}/no-such-route`);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
