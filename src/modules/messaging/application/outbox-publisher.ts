import type { OutboxMessage } from '../domain/outbox-message';
import type { OutboxStore } from './outbox-store.port';

/** The external system an event is published to. The SQS adapter is the only implementation. */
export interface OutboxTransportMessage {
  id: string;
  aggregateId: string;
  payload: unknown;
}

export interface OutboxTransport {
  publish(message: OutboxTransportMessage): Promise<void>;
}

export interface OutboxPublisherOptions {
  store: OutboxStore;
  transport: OutboxTransport;
  clock: () => Date;
  newLeaseToken: () => string;
  leaseDurationMs: number;
  batchSize: number;
}

/**
 * Publishes committed outbox events with claim and lease, so concurrent publishers
 * never work on the same event at the same time. The broker call happens outside
 * any database transaction. A crash after the send and before the confirmation
 * republishes the event later, with the same id. Consumers deduplicate it.
 */
export class OutboxPublisher {
  constructor(private readonly options: OutboxPublisherOptions) {}

  /** Returns how many events were published successfully in this pass. */
  async publishOnce(): Promise<number> {
    const now = this.options.clock();
    const token = this.options.newLeaseToken();
    const claimed = await this.options.store.claimDue({
      now,
      leaseUntil: new Date(now.getTime() + this.options.leaseDurationMs),
      token,
      limit: this.options.batchSize,
    });

    let published = 0;
    for (const message of claimed) {
      if (await this.deliver(message, token)) {
        published += 1;
      }
    }
    return published;
  }

  private async deliver(message: OutboxMessage, token: string): Promise<boolean> {
    const attemptAt = this.options.clock();
    let sent = true;
    try {
      await this.options.transport.publish({
        id: message.id,
        aggregateId: message.aggregateId,
        payload: message.payload,
      });
    } catch {
      sent = false;
    }

    // Recording the outcome is outside the try: a failure here must surface, not be counted as a send failure.
    if (sent) {
      message.markPublished(attemptAt);
      await this.options.store.complete(message, token, attemptAt);
      return true;
    }
    message.scheduleRetry(attemptAt);
    await this.options.store.reschedule(message, token);
    return false;
  }
}
