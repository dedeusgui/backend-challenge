import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SqsSettings } from '../../../../src/config/app-config';
import {
  createSqsClient,
  SqsClientLifecycle,
} from '../../../../src/shared/infrastructure/sqs/sqs-connection';

const CREDENTIAL_VARIABLES = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

function settingsWith(endpoint: string | undefined): SqsSettings {
  return {
    region: 'us-east-1',
    endpoint,
    commandQueueName: 'wager-transactions.fifo',
    deadLetterQueueName: 'wager-transactions-dlq.fifo',
    eventsQueueName: 'wager-events.fifo',
  };
}

describe('createSqsClient credentials', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of CREDENTIAL_VARIABLES) {
      saved[name] = process.env[name];
    }
    process.env.AWS_ACCESS_KEY_ID = 'chain-access-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'chain-secret-key';
    delete process.env.AWS_SESSION_TOKEN;
  });

  afterEach(() => {
    for (const name of CREDENTIAL_VARIABLES) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  test('against AWS, the SDK default chain supplies the credentials, not a fixed pair', async () => {
    const client = createSqsClient(settingsWith(undefined));

    const credentials = await client.config.credentials();

    expect(credentials.accessKeyId).toBe('chain-access-key');
  });

  test('against an emulator endpoint, the fixed local pair is used', async () => {
    const client = createSqsClient(settingsWith('http://localhost:4566'));

    const credentials = await client.config.credentials();

    expect(credentials.accessKeyId).toBe('test');
  });
});

describe('SqsClientLifecycle', () => {
  test('shutdown destroys every SQS client it was given, in order', () => {
    const destroyed: string[] = [];
    const named = (name: string) => ({
      destroy: () => {
        destroyed.push(name);
      },
    });
    const lifecycle = new SqsClientLifecycle([named('command'), named('probe')]);

    lifecycle.onApplicationShutdown();

    expect(destroyed).toEqual(['command', 'probe']);
  });
});
