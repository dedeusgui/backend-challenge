import type { ApplicationContext } from '../../../shared/application/application-context';
import { WalletNotFoundError } from '../../../shared/application/application-errors';
import { Money } from '../../../shared/domain/money';
import { NO_METRICS, type MetricsSink } from '../../../shared/observability/metrics';
import type { FinancialRepositories } from '../../../shared/application/ports/financial-unit-of-work.port';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';

export const DEFAULT_LEDGER_PAGE = 50;
export const MAX_LEDGER_PAGE = 200;

export interface LedgerPage {
  entries: Array<{ seq: string; entry: WalletLedgerEntry }>;
  nextCursor: string | null;
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Read-side use cases for wallets. They run in a read transaction without the wallet
 * lock, because reads must never queue behind a financial write.
 */
export class WalletQueries {
  private readonly metrics: MetricsSink;

  constructor(private readonly context: ApplicationContext) {
    this.metrics = context.metrics ?? NO_METRICS;
  }

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.context.unitOfWork.run((repositories) =>
      repositories.wallets.findById(walletId),
    );
    if (wallet === undefined) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }

  async listLedger(
    walletId: string,
    options: { cursor: string | undefined; limit: number },
  ): Promise<LedgerPage> {
    const afterSeq = options.cursor === undefined ? undefined : decodeLedgerCursor(options.cursor);
    const entries = await this.context.unitOfWork.run(async (repositories) => {
      await this.getWalletOrFail(repositories, walletId);
      return repositories.ledger.listPageAfter(walletId, afterSeq, options.limit + 1);
    });

    const page = entries.slice(0, options.limit);
    const hasMore = entries.length > options.limit;
    const last = page.at(-1);
    return {
      entries: page,
      nextCursor: hasMore && last !== undefined ? encodeLedgerCursor(last.seq) : null,
    };
  }

  async reconcile(walletId: string): Promise<ReconciliationReport> {
    const report = await this.context.unitOfWork.run(async (repositories) => {
      const wallet = await this.getWalletOrFail(repositories, walletId);
      const summary = await repositories.ledger.summarize(walletId, wallet.currency);
      const difference = wallet.balance.subtract(summary.calculated);
      return {
        walletId,
        storedBalance: wallet.balance,
        calculatedBalance: summary.calculated,
        difference,
        consistent: difference.isZero() && summary.chainIntact,
        checkedEntries: summary.entries,
      };
    });
    if (!report.consistent) {
      this.metrics.increment('reconciliation_divergences_total');
    }
    return report;
  }

  private async getWalletOrFail(
    repositories: FinancialRepositories,
    walletId: string,
  ): Promise<Wallet> {
    const wallet = await repositories.wallets.findById(walletId);
    if (wallet === undefined) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }
}
