import type { OutboxMessage } from '../domain/outbox-message';

export interface ClaimRequest {
  now: Date;
  leaseUntil: Date;
  token: string;
  limit: number;
}

/** Storage operations the publisher needs. Every write is conditional on the lease token. */
export interface OutboxStore {
  /** Atomically leases up to `limit` unpublished events that are due or whose previous lease expired. */
  claimDue(request: ClaimRequest): Promise<OutboxMessage[]>;
  /**
   * Marks the events published, in one statement, but only those this lease still owns. Resolves with
   * the ids it marked. An event that is missing from the answer lost its lease.
   */
  complete(messages: readonly OutboxMessage[], token: string, at: Date): Promise<readonly string[]>;
  /** Stores the new attempt count and next attempt time, only under this lease. */
  reschedule(message: OutboxMessage, token: string): Promise<boolean>;
}
