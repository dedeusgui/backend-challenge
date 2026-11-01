import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { SqsSettings } from '../../../src/config/app-config';
import { HealthService, type ReadinessReport } from '../../../src/health/health.service';
import { createSqsClient } from '../../../src/shared/infrastructure/sqs/sqs-connection';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

const DEADLINE_MS = 250;
let blackhole: Server;
let endpoint = '';
let database: TestDatabase;
const openSockets = new Set<Socket>();

beforeAll(async () => {
  blackhole = createServer((socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
    // Accept the request and keep the socket open without sending an HTTP response.
  });
  await new Promise<void>((resolve, reject) => {
    blackhole.once('error', reject);
    blackhole.listen(0, '127.0.0.1', () => resolve());
  });
  const address = blackhole.address();
  if (address === null || typeof address === 'string') {
    throw new Error('blackhole did not bind to a TCP port');
  }
  endpoint = `http://127.0.0.1:${address.port}`;
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
  for (const socket of openSockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    blackhole.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

describe('SQS and readiness deadlines', () => {
  test('bounds SQS calls and cancels both readiness probes', async () => {
    const settings: SqsSettings = {
      region: 'us-east-1',
      endpoint,
      commandQueueName: 'commands',
      deadLetterQueueName: 'dead-letter',
      eventsQueueName: 'events',
      requestTimeoutMs: DEADLINE_MS,
    };
    const sqs = createSqsClient(settings);
    const startedAt = Date.now();
    try {
      await expect(
        sqs.send(new GetQueueAttributesCommand({ QueueUrl: `${endpoint}/q`, AttributeNames: [] })),
      ).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(DEADLINE_MS * 6);

      const readinessClient = createSqsClient(settings, { probe: true });
      try {
        const readinessStartedAt = Date.now();
        const report = await new HealthService(
          database.orm,
          readinessClient,
          `${endpoint}/q`,
          DEADLINE_MS,
        ).ready();
        expect(Date.now() - readinessStartedAt).toBeLessThan(DEADLINE_MS * 4);
        expect(report).toEqual({ ready: false, checks: { database: 'up', sqs: 'down' } });

        const queryStartedAt = Date.now();
        await database.orm.em.getConnection().execute('SELECT 1');
        expect(Date.now() - queryStartedAt).toBeLessThan(DEADLINE_MS * 4);

        const connection = database.orm.em.getConnection();
        const execute = connection.execute.bind(connection);
        connection.execute = async (query, params, method, ctx, loggerContext) => {
          if (query === 'SELECT 1') {
            return execute('SELECT pg_sleep(30)', params, method, ctx, loggerContext);
          }
          return execute(query, params, method, ctx, loggerContext);
        };
        let timedDatabaseReport: ReadinessReport;
        try {
          timedDatabaseReport = await new HealthService(
            database.orm,
            readinessClient,
            `${endpoint}/q`,
            DEADLINE_MS,
          ).ready();
        } finally {
          connection.execute = execute;
        }
        expect(timedDatabaseReport.checks.database).toBe('down');

        const recoveredQueryStartedAt = Date.now();
        await database.orm.em.getConnection().execute('SELECT 1');
        expect(Date.now() - recoveredQueryStartedAt).toBeLessThan(DEADLINE_MS * 4);
      } finally {
        readinessClient.destroy();
      }
    } finally {
      sqs.destroy();
    }
  });
});
