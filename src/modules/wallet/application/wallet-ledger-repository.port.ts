import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletLedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Entries in the order they were appended. */
  listByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
}
