import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { queueUrlByName, testSqsClient } from '../support/sqs-test-queues';

/**
 * The command queue that Compose provisions has a redrive policy: after ten deliveries the
 * broker itself moves a message to the dead-letter queue. Ten is above the retry window of the
 * consumer, so a transient outage does not dead-letter a valid command. This test runs against
 * that provisioned pair, because the policy is the thing under test. It needs `bun run infra:up`.
 */
describe('broker redrive of the provisioned command queue', () => {
  test('the command queue redrives to the dead-letter queue after ten deliveries', async () => {
    const client = testSqsClient();
    const commandUrl = await queueUrlByName(client, 'wager-transactions.fifo');
    const deadLetterUrl = await queueUrlByName(client, 'wager-transactions-dlq.fifo');
    const attributes = await client.send(
      new GetQueueAttributesCommand({ QueueUrl: commandUrl, AttributeNames: ['RedrivePolicy'] }),
    );
    const policy = JSON.parse(attributes.Attributes?.RedrivePolicy ?? '{}') as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: string | number;
    };
    expect(String(policy.maxReceiveCount)).toBe('10');
    expect(policy.deadLetterTargetArn?.endsWith(':wager-transactions-dlq.fifo')).toBe(true);

    const group = `redrive-${randomUUID()}`;
    const marker = `redrive-${randomUUID()}`;
    const command = new SqsQueue(client, commandUrl);
    const dead = new SqsQueue(client, deadLetterUrl);
    await command.send(marker, group, marker);

    // Receive without acknowledging, and make the message visible again at once. Each receive counts as a delivery.
    let movedToDeadLetter = false;
    for (let delivery = 0; delivery < 15 && !movedToDeadLetter; delivery += 1) {
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
