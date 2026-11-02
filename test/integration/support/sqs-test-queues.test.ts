import {
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
} from '@aws-sdk/client-sqs';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { closeTestSqs, createTestQueues, testSqsClient } from './sqs-test-queues';

test('closes only its own queues and cleanup is idempotent', async () => {
  const client = testSqsClient();
  const owned = await createTestQueues(client);
  const other = await createTestQueues(client);

  try {
    await owned.close();
    await owned.close();

    await expect(
      client.send(
        new GetQueueAttributesCommand({
          QueueUrl: owned.commandQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      ),
    ).rejects.toThrow();
    await expect(
      client.send(
        new GetQueueAttributesCommand({
          QueueUrl: other.commandQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      ),
    ).resolves.toMatchObject({ Attributes: { QueueArn: expect.any(String) } });
    await closeTestSqs(client, other);
    await expect(
      client.send(
        new GetQueueAttributesCommand({
          QueueUrl: other.commandQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await Promise.allSettled([owned.close(), other.close()]);
    client.destroy();
  }
});

test('includes the execution namespace in every created queue name', async () => {
  const original = process.env.TEST_RESOURCE_NAMESPACE;
  process.env.TEST_RESOURCE_NAMESPACE = 'run-123';
  const client = testSqsClient();
  let queues: Awaited<ReturnType<typeof createTestQueues>> | undefined;
  try {
    queues = await createTestQueues(client);
    expect(Object.values(queues.names).every((name) => name.startsWith('run-123-'))).toBe(true);
  } finally {
    await closeTestSqs(client, queues);
    if (original === undefined) delete process.env.TEST_RESOURCE_NAMESPACE;
    else process.env.TEST_RESOURCE_NAMESPACE = original;
  }
});

test('deletes queues already created when LocalStack rejects a later queue name', async () => {
  const client = testSqsClient();
  const other = await createTestQueues(client);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const firstName = `partial-${suffix}.fifo`;
  const namespace = process.env.TEST_RESOURCE_NAMESPACE?.replace(/[^a-zA-Z0-9_-]/g, '-');
  const expectedName = namespace === undefined ? firstName : `${namespace}-${firstName}`;

  try {
    const failure = await createTestQueues(client, {
      command: firstName,
      deadLetter: `invalid queue-${suffix}`,
      events: `unused-${suffix}`,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ $metadata: { httpStatusCode: 400 } });

    const queues = await client.send(new ListQueuesCommand({ QueueNamePrefix: expectedName }));
    expect(queues.QueueUrls ?? []).toHaveLength(0);
    await expect(
      client.send(
        new GetQueueAttributesCommand({
          QueueUrl: other.commandQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      ),
    ).resolves.toMatchObject({ Attributes: { QueueArn: expect.any(String) } });
  } finally {
    const leaked = await client.send(new ListQueuesCommand({ QueueNamePrefix: expectedName }));
    await Promise.allSettled(
      (leaked.QueueUrls ?? []).map((QueueUrl) => client.send(new DeleteQueueCommand({ QueueUrl }))),
    );
    await closeTestSqs(client, other);
  }
});
