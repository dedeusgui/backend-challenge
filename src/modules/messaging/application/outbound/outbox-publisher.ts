import type { OutboxMessage } from '../../domain/outbox-message';
import { NO_METRICS, type MetricsSink } from '../../../../shared/observability/metrics';
import {
  describeError,
  SILENT_LOGGER,
  type OperationLogger,
} from '../../../../shared/observability/structured-log';
import type { OutboxStore } from '../ports/outbox-store';
import type { OutboxTransport } from '../ports/outbox-transport';

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
 * Publishes committed outbox events with claim and lease, so concurrent publishers never work on the
 * same event at the same time. The broker calls happen outside any database transaction. A batch the
 * broker accepts is marked published in one statement, and each event it refuses is rescheduled alone.
 * A crash after a send and before its mark republishes the events later, with the same ids, and
 * consumers deduplicate them.
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
    const token = this.options.newLeaseToken();
    const claimStarted = performance.now();
    const claimed = await this.options.store.claimDue({
      token,
      leaseMs: this.options.leaseDurationMs,
      limit: this.options.batchSize,
    });
    this.metrics.observe('outbox_claim_ms', performance.now() - claimStarted);
    if (claimed.length === 0) {
      return 0;
    }
    return this.deliver(claimed, token);
  }

  /** Sends one claimed batch. The events that were sent are completed together, and each refused one is rescheduled. */
  private async deliver(batch: readonly OutboxMessage[], token: string): Promise<number> {
    const attemptAt = this.options.clock();
    const sendStarted = performance.now();
    const failures = await this.send(batch);
    this.metrics.observe('outbox_publish_ms', performance.now() - sendStarted);

    const sent = batch.filter((message) => !failures.has(message.id));
    let published = 0;
    if (sent.length > 0) {
      // Recording the outcome is outside any try: a failure here must surface, not be counted as a send failure.
      for (const message of sent) {
        message.markPublished(attemptAt);
      }
      const recorded = new Set(await this.options.store.complete(sent, token, attemptAt));
      for (const message of sent) {
        if (recorded.has(message.id)) {
          published += 1;
          this.metrics.increment('outbox_published_total');
          this.metrics.observe(
            'outbox_lag_seconds',
            (attemptAt.getTime() - message.occurredAt.getTime()) / 1000,
          );
        } else {
          this.metrics.increment('outbox_lost_lease_total');
        }
      }
    }

    for (const message of batch.filter((candidate) => failures.has(candidate.id))) {
      this.metrics.increment('outbox_publish_failures_total');
      this.logger({
        operation: 'outbox.publish',
        status: 'failed',
        messageId: message.id,
        ...describeError(failures.get(message.id)),
      });
      // The store writes the next attempt from the database clock, so this publisher's clock does not set it.
      message.recordFailedAttempt();
      await this.options.store.reschedule(message, token);
    }
    return published;
  }

  /** The failure of each event the transport did not send, by id. A throw fails every event of the batch. */
  private async send(batch: readonly OutboxMessage[]): Promise<Map<string, unknown>> {
    try {
      const failed = await this.options.transport.publish(
        batch.map((message) => ({
          id: message.id,
          aggregateId: message.aggregateId,
          payload: message.payload,
        })),
      );
      return new Map(failed.map((failure) => [failure.id, failure.error]));
    } catch (error) {
      return new Map(batch.map((message) => [message.id, error]));
    }
  }
}
