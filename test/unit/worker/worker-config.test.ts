import { describe, expect, test } from 'bun:test';
import { readWorkerConfig } from '../../../src/config/worker-config';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://wagering:wagering@localhost:5432/wagering',
  AWS_REGION: 'us-east-1',
  SQS_COMMAND_QUEUE: 'wager-transactions.fifo',
  SQS_COMMAND_DLQ: 'wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE: 'wager-events.fifo',
};

describe('worker configuration: WORKER_HTTP_PORT', () => {
  test('the worker publishes no HTTP surface unless a port is set', () => {
    expect(readWorkerConfig(BASE_ENV).httpPort).toBeUndefined();
  });

  test('a port in range is read as a number', () => {
    expect(readWorkerConfig({ ...BASE_ENV, WORKER_HTTP_PORT: '3001' }).httpPort).toBe(3001);
  });

  for (const value of ['0', '65536', '3001.5', 'abc', '-1', '']) {
    test(`"${value}" is refused at start-up`, () => {
      expect(() => readWorkerConfig({ ...BASE_ENV, WORKER_HTTP_PORT: value })).toThrow(
        'WORKER_HTTP_PORT',
      );
    });
  }
});
