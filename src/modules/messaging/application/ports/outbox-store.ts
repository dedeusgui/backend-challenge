import type { OutboxMessage } from '../../domain/outbox-message';

/**
 * A claim names no time. Due events and lease expiry are decided by the database clock, which every publisher
 * shares, so a publisher whose own clock is wrong cannot take an event another publisher still holds.
 */
export interface ClaimRequest {
  token: string;
  leaseMs: number;
  limit: number;
}

/** Storage operations the publisher needs. Every write is conditional on the lease token. */
export interface OutboxStore {
  /**
   * Atomically leases up to `limit` unpublished events that are due, or whose previous lease has expired, by the
   * database clock. The lease lasts `leaseMs` from the database clock too.
   */
  claimDue(request: ClaimRequest): Promise<OutboxMessage[]>;
  /**
   * Marks the events published, in one statement, but only those this lease still owns. Resolves with
   * the ids it marked. An event that is missing from the answer lost its lease.
   */
  complete(messages: readonly OutboxMessage[], token: string, at: Date): Promise<readonly string[]>;
  /** Stores the new attempt count and next attempt time, only under this lease. */
  reschedule(message: OutboxMessage, token: string): Promise<boolean>;
}
