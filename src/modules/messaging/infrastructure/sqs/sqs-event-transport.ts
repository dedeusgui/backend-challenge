import type {
  OutboxTransport,
  OutboxTransportFailure,
  OutboxTransportMessage,
} from '../../application/ports/outbox-transport';

/** The most entries one SendMessageBatch request accepts. */
const BROKER_BATCH_LIMIT = 10;

export interface EventBatchEntry {
  id: string;
  body: string;
  groupId: string;
  deduplicationId: string;
}

export interface EventBatchOutcome {
  sentIds: readonly string[];
  refused: readonly { id: string; code: string; message: string }[];
}

/** The part of the queue adapter that publishes a batch. A test can supply a stand-in. */
export interface EventBatchSender {
  sendBatch(entries: readonly EventBatchEntry[]): Promise<EventBatchOutcome>;
}

/** The broker refused one event. The message names the reason, never the body. */
class EventRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EventRefusedError';
    this.code = code;
  }
}

/**
 * Publishes outbox events to the events FIFO queue, in requests of at most ten. The aggregate id is
 * the message group, so events of one wallet keep their order, and the event id is the deduplication
 * id. An event that a request did not accept is a failure of its own. The others are not.
 */
export class SqsEventTransport implements OutboxTransport {
  constructor(private readonly sender: EventBatchSender) {}

  async publish(messages: readonly OutboxTransportMessage[]): Promise<OutboxTransportFailure[]> {
    const failures: OutboxTransportFailure[] = [];
    for (let start = 0; start < messages.length; start += BROKER_BATCH_LIMIT) {
      const chunk = messages.slice(start, start + BROKER_BATCH_LIMIT);
      failures.push(...(await this.sendRequest(chunk)));
    }
    return failures;
  }

  private async sendRequest(
    chunk: readonly OutboxTransportMessage[],
  ): Promise<OutboxTransportFailure[]> {
    const entries = chunk.map((message) => ({
      id: message.id,
      body: JSON.stringify(message.payload),
      groupId: message.aggregateId,
      deduplicationId: message.id,
    }));
    let outcome: EventBatchOutcome;
    try {
      outcome = await this.sender.sendBatch(entries);
    } catch (error) {
      return chunk.map((message) => ({ id: message.id, error }));
    }

    const accepted = new Set(outcome.sentIds);
    return chunk
      .filter((message) => !accepted.has(message.id))
      .map((message) => {
        const refusal = outcome.refused.find((candidate) => candidate.id === message.id);
        const error =
          refusal === undefined
            ? new Error('the broker did not confirm the event')
            : new EventRefusedError(refusal.code, refusal.message);
        return { id: message.id, error };
      });
  }
}
