import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  GetQueueAttributesCommand,
  type SQSClient,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { createTestQueues, queueUrlByName, testSqsClient } from '../support/sqs-test-queues';

/**
 * The command queue that Compose provisions has a redrive policy: after ten deliveries the
 * broker itself moves a message to the dead-letter queue. Ten is above the retry window of the
 * consumer, so a transient outage does not dead-letter a valid command.
 *
 * The provisioned policy is checked on the provisioned queue. Its behaviour is checked on a private
 * pair that takes the same count, because messages already waiting in the provisioned queue would
 * change how many deliveries the loop needs before it reaches the message under test.
 */
describe('broker redrive of the provisioned command queue', () => {
  test('the command queue redrives to the dead-letter queue after ten deliveries', async () => {
    const client = testSqsClient();
    const attributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrlByName('wager-transactions.fifo'),
        AttributeNames: ['RedrivePolicy'],
      }),
    );
    const policy = JSON.parse(attributes.Attributes?.RedrivePolicy ?? '{}') as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: string | number;
    };
    expect(String(policy.maxReceiveCount)).toBe('10');
    expect(policy.deadLetterTargetArn?.endsWith(':wager-transactions-dlq.fifo')).toBe(true);

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const queues = await createTestQueues(client, {
      command: `redrive-${suffix}`,
      deadLetter: `redrive-dlq-${suffix}`,
      events: `redrive-events-${suffix}`,
    });
    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: queues.commandQueueUrl,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: await arnOf(client, queues.deadLetterQueueUrl),
            maxReceiveCount: String(policy.maxReceiveCount),
          }),
        },
      }),
    );
    const command = new SqsQueue(client, queues.commandQueueUrl);
    const dead = new SqsQueue(client, queues.deadLetterQueueUrl);
    const group = `redrive-${randomUUID()}`;
    const marker = `redrive-${randomUUID()}`;
    await command.send(marker, group, marker);

    // Receive without acknowledging, and make the message visible again at once. Each receive counts as a delivery.
    let movedToDeadLetter = false;
    const deliveryBound = Number(policy.maxReceiveCount) + 5;
    for (let delivery = 0; delivery < deliveryBound && !movedToDeadLetter; delivery += 1) {
      const received = await command.receive({
        maxMessages: 1,
        waitSeconds: 1,
        visibilityTimeoutSeconds: 0,
      });
      for (const message of received) {
        if (message.body === marker) {
          await command.changeVisibility(message.receiptHandle, 0);
        }
      }
      const inDeadLetter = await dead.receive({
        maxMessages: 10,
        waitSeconds: 0,
        visibilityTimeoutSeconds: 0,
      });
      movedToDeadLetter = inDeadLetter.some((message) => message.body === marker);
      for (const message of inDeadLetter) {
        if (message.body !== marker) {
          await dead.changeVisibility(message.receiptHandle, 0);
        }
      }
    }

    expect(movedToDeadLetter).toBe(true);
  }, 60_000);
});

async function arnOf(client: SQSClient, queueUrl: string): Promise<string> {
  const found = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const arn = found.Attributes?.QueueArn;
  if (arn === undefined) {
    throw new Error(`No ARN for ${queueUrl}`);
  }
  return arn;
}
