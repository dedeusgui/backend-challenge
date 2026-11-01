import type { WagerTransaction } from '../../domain/wager-transaction';

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  /** Persists the state of an existing transaction, such as a held one that was resolved or missed again. */
  update(transaction: WagerTransaction): Promise<void>;
  /** Held transactions whose next reference lookup is due at `now`, oldest first. */
  findDueForReferenceLookup(now: Date, limit: number): Promise<WagerTransaction[]>;
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /**
   * The transaction an operation names: the one with its idempotency key, otherwise the one with its
   * external id. The key is the source of truth (ADR 0003), so it wins when the two name different rows.
   */
  findByIdentity(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** What is already processed against a reference. One query answers both questions. */
  processedOutcomesOf(referenceTransactionId: string): Promise<ProcessedOutcomes>;
}

export interface ProcessedOutcomes {
  /** A PROCESSED REFUND or ROLLBACK already reverses the referenced transaction. */
  reversed: boolean;
  /** A PROCESSED WIN or LOSS already settles the referenced BET. */
  settled: boolean;
}
