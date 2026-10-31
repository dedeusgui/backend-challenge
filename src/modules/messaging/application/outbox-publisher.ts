import type { OutboxMessage } from '../domain/outbox-message';
import { NO_METRICS, type MetricsSink } from '../../../shared/observability/metrics';
import {
  describeError,
  SILENT_LOGGER,
  type ErrorFields,
  type OperationLogger,
} from '../../../shared/observability/structured-log';
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
  metrics?: MetricsSink;
  logger?: OperationLogger;
}

/**
 * Publishes committed outbox events with claim and lease, so concurrent publishers
 * never work on the same event at the same time. The broker call happens outside
 * any database transaction. A crash after the send and before the confirmation
 * republishes the event later, with the same id. Consumers deduplicate it.
 */
export class OutboxPublisher {
  private readonly metrics: MetricsSink;
  private readonly logger: OperationLogger;

  constructor(private readonly options: OutboxPublisherOptions) {
    this.metrics = options.metrics ?? NO_METRICS;
    this.logger = options.logger ?? SILENT_LOGGER;
  }

  /** Returns how many events were published successfully in this pass. */
  async publishOnce(): Promise<number> {
    const now = this.options.clock();
    const token = this.options.newLeaseToken();
    const claimStarted = performance.now();
    const claimed = await this.options.store.claimDue({
      now,
      leaseUntil: new Date(now.getTime() + this.options.leaseDurationMs),
      token,
      limit: this.options.batchSize,
    });
    this.metrics.observe('outbox_claim_ms', performance.now() - claimStarted);

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
    let failure: ErrorFields = {};
    const sendStarted = performance.now();
    try {
      await this.options.transport.publish({
        id: message.id,
        aggregateId: message.aggregateId,
        payload: message.payload,
      });
    } catch (error) {
      sent = false;
      failure = describeError(error);
    }
    this.metrics.observe('outbox_publish_ms', performance.now() - sendStarted);

    // Recording the outcome is outside the try: a failure here must surface, not be counted as a send failure.
    if (sent) {
      message.markPublished(attemptAt);
      const recorded = await this.options.store.complete(message, token, attemptAt);
      if (!recorded) {
        this.metrics.increment('outbox_lost_lease_total');
        return false;
      }
      this.metrics.increment('outbox_published_total');
      this.metrics.observe(
        'outbox_lag_seconds',
        (attemptAt.getTime() - message.occurredAt.getTime()) / 1000,
      );
      return true;
    }
    this.metrics.increment('outbox_publish_failures_total');
    this.logger({
      operation: 'outbox.publish',
      status: 'failed',
      messageId: message.id,
      ...failure,
    });
    message.scheduleRetry(attemptAt);
    await this.options.store.reschedule(message, token);
    return false;
  }
}
