import type { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind';

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
  /** True when a PROCESSED reversal of this kind already applies to the referenced transaction. */
  hasProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean>;
}
