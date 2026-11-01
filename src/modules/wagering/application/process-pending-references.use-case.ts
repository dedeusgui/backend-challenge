import type { ApplicationContext } from '../../../shared/application/application-context';
import { WalletNotFoundError } from '../../../shared/application/application-errors';
import type { FinancialRepositories } from '../../../shared/application/ports/financial-unit-of-work.port';
import { NO_METRICS, type MetricsSink } from '../../../shared/observability/metrics';
import { TransactionSettlement } from './transaction-settlement';

const BATCH_SIZE = 20;

/**
 * Re-examines held transactions whose next reference lookup is due. Each one is resolved
 * under its wallet lock and re-read there, so two workers never apply the same transaction
 * twice. The schedule lives in the database, and both the due check and the next lookup are
 * timed on the database clock, so a worker whose own clock is skewed decides nothing by it.
 */
export class ProcessPendingReferences {
  private readonly settlement: TransactionSettlement;
  private readonly metrics: MetricsSink;

  constructor(private readonly context: ApplicationContext) {
    this.settlement = new TransactionSettlement(context);
    this.metrics = context.metrics ?? NO_METRICS;
  }

  /** Returns how many due transactions were examined in this pass. */
  async runOnce(): Promise<number> {
    const due = await this.context.unitOfWork.run(async (repositories) =>
      repositories.wagers.findDueForReferenceLookup(
        await repositories.databaseClock.now(),
        BATCH_SIZE,
      ),
    );

    let examined = 0;
    for (const candidate of due) {
      examined += await this.context.unitOfWork.run((repositories) =>
        this.resolveOne(repositories, candidate.id, candidate.walletId),
      );
    }
    return examined;
  }

  private async resolveOne(
    repositories: FinancialRepositories,
    transactionId: string,
    walletId: string,
  ): Promise<number> {
    const wallet = await repositories.wallets.findForUpdate(walletId);
    if (wallet === undefined) {
      throw new WalletNotFoundError(walletId);
    }
    const transaction = await repositories.wagers.findById(transactionId);
    const now = await repositories.databaseClock.now();
    if (transaction === undefined || !transaction.isDueForReferenceLookup(now)) {
      return 0;
    }

    const outcome = await this.settlement.settle(repositories, transaction, wallet, {
      existing: true,
      correlationId: transaction.id,
      causationId: undefined,
    });
    this.metrics.increment('reference_resolutions_total', { status: outcome.transaction.status });
    return 1;
  }
}
