import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type {
  MessageQueue,
  ReceiveOptions,
  ReceivedMessage,
} from '../../application/message-queue.port';

export interface SendBatchEntry {
  id: string;
  body: string;
  groupId: string;
  deduplicationId: string;
}

export interface SendBatchOutcome {
  /** The ids the broker accepted. An entry that is not listed here was not accepted. */
  sentIds: readonly string[];
  refused: readonly { id: string; code: string; message: string }[];
}

/** Thin adapter over one FIFO queue. It translates SDK calls and nothing else. */
export class SqsQueue implements MessageQueue {
  constructor(
    private readonly client: SQSClient,
    readonly queueUrl: string,
  ) {}

  async send(body: string, groupId: string, deduplicationId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }

  /** One SendMessageBatch request of at most ten entries. The broker answers each entry on its own. */
  async sendBatch(entries: readonly SendBatchEntry[]): Promise<SendBatchOutcome> {
    const response = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries: entries.map((entry) => ({
          Id: entry.id,
          MessageBody: entry.body,
          MessageGroupId: entry.groupId,
          MessageDeduplicationId: entry.deduplicationId,
        })),
      }),
    );
    return {
      sentIds: (response.Successful ?? []).flatMap((entry) =>
        entry.Id === undefined ? [] : [entry.Id],
      ),
      refused: (response.Failed ?? []).flatMap((entry) =>
        entry.Id === undefined
          ? []
          : [{ id: entry.Id, code: entry.Code ?? 'Unknown', message: entry.Message ?? '' }],
      ),
    };
  }

  async receive(options: ReceiveOptions): Promise<ReceivedMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitSeconds,
        VisibilityTimeout: options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    const received: ReceivedMessage[] = [];
    for (const message of response.Messages ?? []) {
      if (message.ReceiptHandle === undefined) {
        continue;
      }
      received.push({
        receiptHandle: message.ReceiptHandle,
        body: message.Body ?? '',
        receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
      });
    }
    return received;
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /** Messages still in the queue: visible ones plus those delivered and not yet acknowledged. */
  async pendingCount(): Promise<number> {
    const response = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return (
      Number(response.Attributes?.ApproximateNumberOfMessages ?? '0') +
      Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0')
    );
  }

  /** Messages delivered and not yet acknowledged, which are invisible to other receivers. */
  async countInFlight(): Promise<number> {
    const response = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0');
  }
}
