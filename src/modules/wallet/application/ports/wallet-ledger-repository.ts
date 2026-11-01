import type { Money } from '../../../../shared/domain/money';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface LedgerPageEntry {
  /** The database sequence of the entry. It orders the ledger and backs the pagination cursor. */
  seq: string;
  entry: WalletLedgerEntry;
}

export interface LedgerSummary {
  /** CREDIT minus DEBIT across every entry of the wallet. */
  calculated: Money;
  entries: number;
  /** False when some entry does not start where the previous one ended, or the first entry does not start at zero. */
  chainIntact: boolean;
}

export interface WalletLedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Entries in the order they were appended. */
  listByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
  /** The next page after `afterSeq`, in sequence order. */
  listPageAfter(
    walletId: string,
    afterSeq: string | undefined,
    limit: number,
  ): Promise<LedgerPageEntry[]>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}
