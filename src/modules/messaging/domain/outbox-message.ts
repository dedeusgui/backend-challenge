import { DomainError } from '../../../shared/domain/domain-error';
import type {
  IntegrationEnvelope,
  IntegrationEvent,
} from '../../../shared/domain/integration-event';

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

/** Exponential backoff after `failedAttempts` failures: 1 s, 2 s, 4 s, ... capped at 60 s. */
export function retryDelayMs(failedAttempts: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** (failedAttempts - 1), MAX_RETRY_DELAY_MS);
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: IntegrationEnvelope<unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
  quarantined?: boolean;
}

/**
 * A committed integration event waiting to be published. Its id is the event id,
 * so every republication carries the same identity for consumers to deduplicate.
 * Lease ownership belongs to persistence, not to this entity.
 */
export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: IntegrationEnvelope<unknown>;
  readonly occurredAt: Date;
  private currentAttempts: number;
  private currentNextAttemptAt: Date;
  private currentPublishedAt: Date | undefined;
  private currentQuarantined: boolean;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = state.payload;
    this.occurredAt = state.occurredAt;
    this.currentAttempts = state.attempts;
    this.currentNextAttemptAt = state.nextAttemptAt;
    this.currentPublishedAt = state.publishedAt;
    this.currentQuarantined = state.quarantined ?? false;
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: envelope,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: undefined,
      quarantined: false,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get attempts(): number {
    return this.currentAttempts;
  }

  get nextAttemptAt(): Date {
    return this.currentNextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this.currentPublishedAt;
  }

  get quarantined(): boolean {
    return this.currentQuarantined;
  }

  quarantine(): void {
    this.assertPending();
    this.currentQuarantined = true;
  }

  isPending(): boolean {
    return this.currentPublishedAt === undefined && !this.currentQuarantined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this.currentNextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending();
    this.currentPublishedAt = at;
  }

  /** Records a failed publication and postpones the next attempt with exponential backoff. */
  /**
   * Counts a failed send. The next attempt time is not set here: the store writes it from the database clock, as
   * now() plus retryDelayMs(attempts), under the lease. So `nextAttemptAt` is the time as it was last read.
   */
  recordFailedAttempt(): void {
    this.assertPending();
    this.currentAttempts += 1;
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new DomainError(
        'INVALID_OUTBOX_TRANSITION',
        `Outbox message ${this.id} is already published`,
      );
    }
  }
}
