import type { OutboxTransport, OutboxTransportMessage } from '../../application/outbox-publisher';
import { SqsQueue } from './sqs-queue';

/**
 * Publishes outbox events to the events FIFO queue. The aggregate id is the message
 * group, so events of one wallet keep their order. The event id is the deduplication id.
 */
export class SqsEventTransport implements OutboxTransport {
  constructor(private readonly queue: SqsQueue) {}

  async publish(message: OutboxTransportMessage): Promise<void> {
    await this.queue.send(JSON.stringify(message.payload), message.aggregateId, message.id);
  }
}
