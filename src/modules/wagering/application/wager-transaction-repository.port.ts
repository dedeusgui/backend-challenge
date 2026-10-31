import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  /** Persists the state of an existing transaction, such as a held one that was resolved or missed again. */
  update(transaction: WagerTransaction): Promise<void>;
  /** Held transactions whose next reference lookup is due at `now`, oldest first. */
  findDueForReferenceLookup(now: Date, limit: number): Promise<WagerTransaction[]>;
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** True when a PROCESSED REFUND or ROLLBACK already reverses the referenced transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** True when a PROCESSED WIN or LOSS already settles the referenced BET. */
  hasProcessedResult(referenceTransactionId: string): Promise<boolean>;
}
