import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
}
