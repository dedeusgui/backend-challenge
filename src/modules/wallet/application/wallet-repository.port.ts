import type { Wallet } from '../domain/wallet';

export interface WalletRepository {
  findById(walletId: string): Promise<Wallet | undefined>;
  /** Reads the wallet under a row lock that lasts until the surrounding transaction ends. */
  findForUpdate(walletId: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /**
   * Persists the balance and version of a wallet that was read at `expectedVersion`.
   * Throws ConcurrencyConflictError if the stored version no longer matches.
   */
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}
