import type { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind';

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
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
