import type { LedgerPage, ReconciliationReport } from '../application/wallet-queries';
import type { Wallet } from '../domain/wallet';
import type { OpenWalletOutcome } from '../application/open-wallet.use-case';

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export function presentOpenedWallet(outcome: OpenWalletOutcome, playerId: string): WalletResponse {
  return {
    id: outcome.walletId,
    playerId,
    balance: outcome.balance.toJSON(),
    version: outcome.version,
  };
}

export function presentWallet(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function presentLedgerPage(page: LedgerPage) {
  return {
    entries: page.entries.map(({ seq, entry }) => ({
      seq,
      id: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      createdAt: entry.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

export function presentReconciliation(report: ReconciliationReport) {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
  };
}
