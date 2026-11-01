import type { ApplicationContext } from '../../../shared/application/application-context';
import { WalletNotFoundError } from '../../../shared/application/application-errors';
import { classifyCommandFailure } from '../../../shared/application/failure-classification';
import type { FinancialRepositories } from '../../../shared/application/ports/financial-unit-of-work';
import { NO_METRICS, type MetricsSink } from '../../../shared/observability/metrics';
import { WagerTransactionFailed } from '../domain/events/wager-transaction-failed.event';
import { TransactionSettlement } from './transaction-settlement';

const BATCH_SIZE = 20;

/** The failure code of a held transaction that cannot be resolved for a permanent reason. */
const FAILED_CODE = 'PROCESSING_FAILED';

/**
 * Re-examines held transactions whose next reference lookup is due. Each one is resolved
 * under its wallet lock and re-read there, so two workers never apply the same transaction
 * twice. The schedule lives in the database, and both the due check and the next lookup are
 * timed on the database clock, so a worker whose own clock is skewed decides nothing by it.
 *
 * A held transaction that fails permanently is recorded FAILED, in a unit of work of its own,
 * and announced. It cannot hold up the held transactions due after it. A transient failure is
 * not a verdict: it ends the pass with its error, and the transaction is looked up again.
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
      examined += await this.resolveGuarded(candidate.id, candidate.walletId);
    }
    return examined;
  }

  private async resolveGuarded(transactionId: string, walletId: string): Promise<number> {
    try {
      return await this.context.unitOfWork.run((repositories) =>
        this.resolveOne(repositories, transactionId, walletId),
      );
    } catch (error) {
      if (classifyCommandFailure(error) === 'TRANSIENT') {
        throw error;
      }
      // The failed unit of work committed nothing, so the verdict is recorded in a new one.
      const recorded = await this.context.unitOfWork.run((repositories) =>
        this.recordFailure(repositories, transactionId),
      );
      if (recorded) {
        this.metrics.increment('reference_resolutions_total', { status: 'FAILED' });
      }
      return recorded ? 1 : 0;
    }
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

  /**
   * Records a held transaction as FAILED, with the balance it was held with, and announces it. Returns false when
   * the transaction is no longer held, because another worker decided it first.
   */
  private async recordFailure(
    repositories: FinancialRepositories,
    transactionId: string,
  ): Promise<boolean> {
    const transaction = await repositories.wagers.findById(transactionId);
    if (transaction === undefined || transaction.status !== 'PENDING_REFERENCE') {
      return false;
    }
    transaction.fail({ code: FAILED_CODE, observedBalance: transaction.resultingBalance });
    await repositories.wagers.update(transaction);
    await repositories.outbox.enqueue(
      WagerTransactionFailed.from(transaction, {
        eventId: this.context.newId(),
        correlationId: transaction.id,
        causationId: undefined,
        occurredAt: this.context.clock(),
      }),
    );
    return true;
  }
}
