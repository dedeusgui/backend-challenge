import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { resolveQueues } from '../../../../src/shared/infrastructure/sqs/sqs-connection';

/**
 * With an endpoint, the queue URLs are built from it. Without one (production), each queue is looked up by name,
 * and a queue that does not exist stops the worker at start-up rather than failing later on its first send.
 */

const SETTINGS = {
  region: 'us-east-1',
  endpoint: undefined,
  commandQueueName: 'commands.fifo',
  deadLetterQueueName: 'commands-dlq.fifo',
  eventsQueueName: 'events.fifo',
};

function clientKnowing(names: Record<string, string>): SQSClient {
  return {
    send: async (command: { input: { QueueName?: string } }) => {
      const name = command.input.QueueName ?? '';
      const url = names[name];
      return url === undefined ? {} : { QueueUrl: url };
    },
  } as unknown as SQSClient;
}

describe('queue resolution', () => {
  test('with an endpoint, the URLs are built from the endpoint and the account, without a lookup', async () => {
    const client = {
      send: async () => Promise.reject(new Error('no lookup is expected')),
    } as unknown as SQSClient;
    const urls = await resolveQueues(client, { ...SETTINGS, endpoint: 'http://localstack:4566' });
    expect(urls).toEqual({
      commandQueueUrl: 'http://localstack:4566/000000000000/commands.fifo',
      deadLetterQueueUrl: 'http://localstack:4566/000000000000/commands-dlq.fifo',
      eventsQueueUrl: 'http://localstack:4566/000000000000/events.fifo',
    });
  });

  test('without an endpoint, each queue is looked up by its name', async () => {
    const client = clientKnowing({
      'commands.fifo': 'https://sqs/1/commands.fifo',
      'commands-dlq.fifo': 'https://sqs/1/commands-dlq.fifo',
      'events.fifo': 'https://sqs/1/events.fifo',
    });
    expect(await resolveQueues(client, SETTINGS)).toEqual({
      commandQueueUrl: 'https://sqs/1/commands.fifo',
      deadLetterQueueUrl: 'https://sqs/1/commands-dlq.fifo',
      eventsQueueUrl: 'https://sqs/1/events.fifo',
    });
  });

  test('a queue that does not exist stops the start-up, and names the queue', async () => {
    const client = clientKnowing({ 'commands.fifo': 'https://sqs/1/commands.fifo' });
    await expect(resolveQueues(client, SETTINGS)).rejects.toThrow(
      'Queue commands-dlq.fifo does not exist',
    );
  });
});
