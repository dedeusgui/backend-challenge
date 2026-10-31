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
  /** Marks published only if this lease still owns the event. Returns false when ownership was lost. */
  complete(message: OutboxMessage, token: string, at: Date): Promise<boolean>;
  /** Stores the new attempt count and next attempt time, only under this lease. */
  reschedule(message: OutboxMessage, token: string): Promise<boolean>;
}
