import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

export const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

export function testSqsClient(): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export async function closeTestSqs(
  client: SQSClient | undefined,
  queues: TestQueues | undefined,
): Promise<void> {
  if (client === undefined) return;
  try {
    await queues?.close();
  } finally {
    client.destroy();
  }
}

export interface TestQueues {
  commandQueueUrl: string;
  deadLetterQueueUrl: string;
  eventsQueueUrl: string;
  names: { command: string; deadLetter: string; events: string };
  close(): Promise<void>;
}

/** Creates three private FIFO queues; close deletes only these queues, not other suites' resources. */
export async function createTestQueues(
  client: SQSClient,
  requestedNames?: { command: string; deadLetter: string; events: string },
): Promise<TestQueues> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const namespace = process.env.TEST_RESOURCE_NAMESPACE?.replace(/[^a-zA-Z0-9_-]/g, '-');
  const queueName = (base: string): string => {
    const fifo = base.endsWith('.fifo') ? base : `${base}.fifo`;
    const name = namespace === undefined ? fifo : `${namespace}-${fifo}`;
    if (name.length > 80) throw new Error(`SQS queue name exceeds 80 characters: ${name}`);
    return name;
  };
  const names = {
    command: queueName(requestedNames?.command ?? `commands-${suffix}`),
    deadLetter: queueName(requestedNames?.deadLetter ?? `dead-letter-${suffix}`),
    events: queueName(requestedNames?.events ?? `events-${suffix}`),
  };
  const created: string[] = [];
  const create = async (name: string): Promise<string> => {
    try {
      const result = await client.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
        }),
      );
      if (result.QueueUrl === undefined) {
        throw new Error(`LocalStack did not return a URL for ${name}`);
      }
      created.push(result.QueueUrl);
      return result.QueueUrl;
    } catch (error) {
      if (created.length > 0) {
        const cleanup = await Promise.allSettled(
          created.map((QueueUrl) => client.send(new DeleteQueueCommand({ QueueUrl }))),
        );
        const failures = [
          error,
          ...cleanup.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
        ];
        if (failures.length > 1) {
          throw new AggregateError(failures, 'SQS queue setup and cleanup failed', {
            cause: error,
          });
        }
      }
      throw error;
    }
  };
  const commandQueueUrl = await create(names.command);
  const deadLetterQueueUrl = await create(names.deadLetter);
  const eventsQueueUrl = await create(names.events);
  let closePromise: Promise<void> | undefined;
  let closed = false;
  return {
    commandQueueUrl,
    deadLetterQueueUrl,
    eventsQueueUrl,
    names,
    close() {
      if (closed) return Promise.resolve();
      if (closePromise) return closePromise;
      closePromise = Promise.all(
        created.map((QueueUrl) => client.send(new DeleteQueueCommand({ QueueUrl }))),
      )
        .then(() => {
          closed = true;
        })
        .finally(() => {
          closePromise = undefined;
        });
      return closePromise;
    },
  };
}

/**
 * The URL of a provisioned queue, built from the endpoint as `resolveQueues` does in production.
 * An emulator's own URL may name a host this process cannot use, and the SDK then fails on the
 * next call. The caller's next request proves that the queue exists.
 */
export function queueUrlByName(name: string): string {
  return `${SQS_ENDPOINT}/000000000000/${name}`;
}
