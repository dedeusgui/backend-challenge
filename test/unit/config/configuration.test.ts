import { describe, expect, test } from 'bun:test';
import { readAppConfig, readSqsSettings } from '../../../src/config/app-config';
import { readWorkerConfig } from '../../../src/config/worker-config';

/**
 * The configuration fails fast on anything missing or malformed, and takes a documented default for everything
 * else. Each refusal below is a branch of the reader, named by what it refuses.
 */

const REQUIRED = { DATABASE_URL: 'postgresql://wagering:wagering@localhost:5432/wagering' };

function refusedWith(action: () => unknown): string {
  try {
    action();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('the application configuration', () => {
  test('takes the documented defaults when only the database is given', () => {
    expect(readAppConfig(REQUIRED)).toEqual({
      port: 3000,
      databaseUrl: REQUIRED.DATABASE_URL,
      sqs: {
        region: 'us-east-1',
        endpoint: undefined,
        commandQueueName: 'wager-transactions.fifo',
        deadLetterQueueName: 'wager-transactions-dlq.fifo',
        eventsQueueName: 'wager-events.fifo',
      },
    });
  });

  test('refuses a port that is not an integer from 1 to 65535', () => {
    for (const port of ['0', '65536', '3000.5', 'abc', '-1']) {
      expect(refusedWith(() => readAppConfig({ ...REQUIRED, PORT: port }))).toBe(
        'PORT must be an integer between 1 and 65535',
      );
    }
  });

  test('refuses a missing or blank database URL, and names the variable', () => {
    expect(refusedWith(() => readAppConfig({}))).toBe('DATABASE_URL is required');
    expect(refusedWith(() => readAppConfig({ DATABASE_URL: '   ' }))).toBe(
      'DATABASE_URL is required',
    );
  });

  test('an SQS endpoint that is only spaces is no endpoint at all', () => {
    expect(readSqsSettings({ SQS_ENDPOINT: '   ' }).endpoint).toBeUndefined();
    expect(readSqsSettings({ SQS_ENDPOINT: ' http://localstack:4566 ' }).endpoint).toBe(
      'http://localstack:4566',
    );
  });

  test('queue names and region come from the environment when they are given', () => {
    expect(
      readSqsSettings({
        AWS_REGION: 'sa-east-1',
        SQS_COMMAND_QUEUE: 'commands.fifo',
        SQS_COMMAND_DLQ: 'commands-dlq.fifo',
        SQS_EVENTS_QUEUE: 'events.fifo',
      }),
    ).toEqual({
      region: 'sa-east-1',
      endpoint: undefined,
      commandQueueName: 'commands.fifo',
      deadLetterQueueName: 'commands-dlq.fifo',
      eventsQueueName: 'events.fifo',
    });
  });
});

describe('the worker configuration', () => {
  test('takes the documented tuning when only the database is given, and no HTTP surface', () => {
    const config = readWorkerConfig(REQUIRED);
    expect({
      visibility: config.consumerVisibilitySeconds,
      batch: config.outboxBatchSize,
      lease: config.outboxLeaseMs,
      idle: config.outboxIdleDelayMs,
      httpPort: config.httpPort,
    }).toEqual({ visibility: 30, batch: 20, lease: 30_000, idle: 500, httpPort: undefined });
  });

  test('refuses a missing database URL with the same name as the application', () => {
    expect(refusedWith(() => readWorkerConfig({}))).toBe('DATABASE_URL is required');
  });

  test('refuses a tuning value that is not a positive integer, and names it', () => {
    for (const name of [
      'CONSUMER_VISIBILITY_SECONDS',
      'OUTBOX_BATCH_SIZE',
      'OUTBOX_LEASE_MS',
      'OUTBOX_IDLE_DELAY_MS',
    ]) {
      for (const value of ['0', '-5', '1.5', 'many']) {
        expect(refusedWith(() => readWorkerConfig({ ...REQUIRED, [name]: value }))).toBe(
          `${name} must be a positive integer`,
        );
      }
    }
  });

  test('refuses a worker HTTP port outside 1 to 65535, and accepts a valid one', () => {
    for (const port of ['0', '70000', '80.5', 'x']) {
      expect(refusedWith(() => readWorkerConfig({ ...REQUIRED, WORKER_HTTP_PORT: port }))).toBe(
        'WORKER_HTTP_PORT must be a port number from 1 to 65535',
      );
    }
    expect(readWorkerConfig({ ...REQUIRED, WORKER_HTTP_PORT: '9100' }).httpPort).toBe(9100);
  });
});
