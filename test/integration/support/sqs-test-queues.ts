import { CreateQueueCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

export const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

export function testSqsClient(): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export interface TestQueues {
  commandQueueUrl: string;
  deadLetterQueueUrl: string;
  eventsQueueUrl: string;
}

/** Creates three private FIFO queues, so each test file sees only its own messages. */
export async function createTestQueues(
  client: SQSClient,
  names?: { command: string; deadLetter: string; events: string },
): Promise<TestQueues> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const create = async (name: string): Promise<string> => {
    const created = await client.send(
      new CreateQueueCommand({
        QueueName: name.endsWith('.fifo') ? name : `${name}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    if (created.QueueUrl === undefined) {
      throw new Error(`LocalStack did not return a URL for ${name}`);
    }
    return created.QueueUrl;
  };
  return {
    commandQueueUrl: await create(names?.command ?? `commands-${suffix}`),
    deadLetterQueueUrl: await create(names?.deadLetter ?? `dead-letter-${suffix}`),
    eventsQueueUrl: await create(names?.events ?? `events-${suffix}`),
  };
}

export async function queueUrlByName(client: SQSClient, name: string): Promise<string> {
  const found = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  return found.QueueUrl ?? '';
}
