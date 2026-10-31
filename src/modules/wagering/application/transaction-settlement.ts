import type { ApplicationContext } from '../../../shared/application/application-context';
import type { FinancialRepositories } from '../../../shared/application/ports/financial-unit-of-work.port';
import type { IntegrationEventContext } from '../../../shared/domain/integration-event';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed.event';
import type { Wallet } from '../../wallet/domain/wallet';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected.event';
import type { FailureCode } from '../domain/failure-code';
import { referenceRetryDelayMs } from '../domain/reference-retry-policy';
import type { Money } from '../../../shared/domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import { NO_METRICS, type MetricsSink } from '../../../shared/observability/metrics';

export interface SettlementOutcome {
  transaction: WagerTransaction;
  /** Balance after the operation, or the balance observed when it was rejected or is pending. */
  balance: Money;
  idempotentReplay: boolean;
}

export interface SettlementOptions {
  /** True when the transaction was created earlier and is waiting for its reference. */
  existing: boolean;
  correlationId: string;
  causationId: string | undefined;
}

/**
 * The one place where a transaction is decided against its wallet. The HTTP and queue
 * path (ProcessWagerTransaction) and the reference worker both call it, so the financial
 * rules exist in one implementation. The caller holds the wallet lock and the unit of work.
 */
export class TransactionSettlement {
  private readonly metrics: MetricsSink;

  constructor(private readonly context: ApplicationContext) {
    this.metrics = context.metrics ?? NO_METRICS;
  }

  async settle(
    repositories: FinancialRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    options: SettlementOptions,
  ): Promise<SettlementOutcome> {
    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? undefined
        : await repositories.wagers.findByExternalId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          );

    const walletMismatch = transaction.walletMismatch(wallet);
    if (walletMismatch !== undefined) {
      return this.reject(repositories, transaction, wallet, walletMismatch, options);
    }

    const evaluation = transaction.evaluateReference(reference);
    if (evaluation.outcome === 'WAIT') {
      return this.holdOrRecordMiss(repositories, transaction, wallet, options);
    }
    if (evaluation.outcome === 'REJECT') {
      return this.reject(repositories, transaction, wallet, evaluation.code, options);
    }

    // A referenced transaction is reversed at most once, whatever the kind of reversal. A
    // WIN on a BET that was already refunded or rolled back is refused for the same reason.
    if (reference !== undefined && (await repositories.wagers.hasProcessedReversal(reference.id))) {
      return this.reject(repositories, transaction, wallet, 'REFERENCE_ALREADY_REVERSED', options);
    }

    // A BET settles once. A second result, or a REFUND after a result, is refused. ROLLBACK is
    // not checked here: it applies in every state of the transaction it reverses.
    if (
      reference !== undefined &&
      transaction.requiresUnsettledReference() &&
      (await repositories.wagers.hasProcessedResult(reference.id))
    ) {
      return this.reject(repositories, transaction, wallet, 'REFERENCE_ALREADY_SETTLED', options);
    }

    if (!transaction.affectsBalance()) {
      return this.finishWithoutBalanceChange(repositories, transaction, reference, wallet, options);
    }
    return this.applyBalanceChange(repositories, transaction, reference, wallet, options);
  }

  private async applyBalanceChange(
    repositories: FinancialRepositories,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    wallet: Wallet,
    options: SettlementOptions,
  ): Promise<SettlementOutcome> {
    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === 'DEBIT' && !wallet.canDebit(transaction.money)) {
      const code: FailureCode = transaction.isReversal()
        ? 'REVERSAL_WOULD_OVERDRAW'
        : 'INSUFFICIENT_BALANCE';
      return this.reject(repositories, transaction, wallet, code, options);
    }

    const expectedVersion = wallet.version;
    const movement = {
      entryId: this.context.newId(),
      transactionId: transaction.id,
      money: transaction.money,
      at: this.context.clock(),
    };
    const entry = direction === 'DEBIT' ? wallet.debit(movement) : wallet.credit(movement);
    transaction.markProcessed({
      referenceTransactionId: reference?.id,
      resultingBalance: wallet.balance,
      at: movement.at,
    });

    await this.save(repositories, transaction, options);
    await repositories.wallets.save(wallet, expectedVersion);
    await repositories.ledger.append(entry);

    const eventContext = this.eventContext(options);
    await repositories.outbox.enqueue(WagerTransactionProcessed.from(transaction, eventContext));
    await repositories.outbox.enqueue(
      WalletBalanceChanged.from(wallet, entry, { ...eventContext, eventId: this.context.newId() }),
    );
    return { transaction, balance: wallet.balance, idempotentReplay: false };
  }

  private async finishWithoutBalanceChange(
    repositories: FinancialRepositories,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    wallet: Wallet,
    options: SettlementOptions,
  ): Promise<SettlementOutcome> {
    transaction.markProcessed({
      referenceTransactionId: reference?.id,
      resultingBalance: wallet.balance,
      at: this.context.clock(),
    });
    await this.save(repositories, transaction, options);
    await repositories.outbox.enqueue(
      WagerTransactionProcessed.from(transaction, this.eventContext(options)),
    );
    return { transaction, balance: wallet.balance, idempotentReplay: false };
  }

  private async reject(
    repositories: FinancialRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    options: SettlementOptions,
  ): Promise<SettlementOutcome> {
    transaction.reject({ code, observedBalance: wallet.balance });
    await this.save(repositories, transaction, options);
    await repositories.outbox.enqueue(
      WagerTransactionRejected.from(transaction, this.eventContext(options)),
    );
    return { transaction, balance: wallet.balance, idempotentReplay: false };
  }

  /**
   * First miss: hold the transaction and announce it. Later misses: count them against the
   * limit, and reject with REFERENCE_NOT_FOUND once the limit is reached.
   */
  private async holdOrRecordMiss(
    repositories: FinancialRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    options: SettlementOptions,
  ): Promise<SettlementOutcome> {
    if (!options.existing) {
      transaction.markPendingReference(
        new Date(this.context.clock().getTime() + referenceRetryDelayMs(0)),
      );
      await repositories.wagers.insert(transaction);
      await repositories.outbox.enqueue(
        WagerTransactionPendingReference.from(transaction, this.eventContext(options)),
      );
      return { transaction, balance: wallet.balance, idempotentReplay: false };
    }

    const { exhausted } = transaction.recordReferenceMiss(this.context.clock());
    if (exhausted) {
      this.metrics.increment('reference_exhausted_total');
      return this.reject(repositories, transaction, wallet, 'REFERENCE_NOT_FOUND', options);
    }
    await repositories.wagers.update(transaction);
    return { transaction, balance: wallet.balance, idempotentReplay: false };
  }

  private save(
    repositories: FinancialRepositories,
    transaction: WagerTransaction,
    options: SettlementOptions,
  ): Promise<void> {
    return options.existing
      ? repositories.wagers.update(transaction)
      : repositories.wagers.insert(transaction);
  }

  private eventContext(options: SettlementOptions): IntegrationEventContext {
    return {
      eventId: this.context.newId(),
      correlationId: options.correlationId,
      causationId: options.causationId,
      occurredAt: this.context.clock(),
    };
  }
}
