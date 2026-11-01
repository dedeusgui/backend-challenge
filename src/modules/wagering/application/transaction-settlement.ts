import type { ApplicationContext } from '../../../shared/application/application-context';
import type { FinancialRepositories } from '../../../shared/application/ports/financial-unit-of-work';
import type { ProcessedOutcomes } from './ports/wager-transaction-repository';
import type { IntegrationEventContext } from '../../../shared/domain/integration-event';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed.event';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected.event';
import type { FailureCode } from '../domain/failure-code';
import { referenceRetryDelayMs } from '../domain/reference-retry-policy';
import { decideAgainstHistory } from '../domain/wager-lifecycle';
import type { Money } from '../../../shared/domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import { NO_METRICS, type MetricsSink } from '../../../shared/observability/metrics';

const NO_PROCESSED_OUTCOMES: ProcessedOutcomes = { reversed: false, settled: false };

export interface SettlementOutcome {
  transaction: WagerTransaction;
  /** Balance after the operation, or the balance observed when it was rejected or is pending. */
  balance: Money;
  idempotentReplay: boolean;
}

interface SettlementOptions {
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
    const started = performance.now();
    try {
      return await this.decide(repositories, transaction, wallet, options);
    } finally {
      this.metrics.observe('settlement_ms', performance.now() - started);
    }
  }

  private async decide(
    repositories: FinancialRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    options: SettlementOptions,
  ): Promise<SettlementOutcome> {
    const reference = await this.findReference(repositories, transaction);

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

    const historyCode = await this.checkHistoryRejection(repositories, transaction.kind, reference);
    if (historyCode !== undefined) {
      return this.reject(repositories, transaction, wallet, historyCode, options);
    }

    if (!transaction.affectsBalance()) {
      return this.finishWithoutBalanceChange(repositories, transaction, reference, wallet, options);
    }
    return this.applyBalanceChange(repositories, transaction, reference, wallet, options);
  }

  private findReference(
    repositories: FinancialRepositories,
    transaction: WagerTransaction,
  ): Promise<WagerTransaction | undefined> {
    if (transaction.referenceExternalTransactionId === undefined) {
      return Promise.resolve(undefined);
    }
    return repositories.wagers.findByExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId,
    );
  }

  private async checkHistoryRejection(
    repositories: FinancialRepositories,
    kind: WagerTransaction['kind'],
    reference: WagerTransaction | undefined,
  ): Promise<FailureCode | undefined> {
    const history =
      reference === undefined
        ? NO_PROCESSED_OUTCOMES
        : await repositories.wagers.processedOutcomesOf(reference.id);
    const decision = decideAgainstHistory(kind, history);
    return decision.outcome === 'REJECT' ? decision.code : undefined;
  }

  private async applyBalanceChange(
    repositories: FinancialRepositories,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    wallet: Wallet,
    options: SettlementOptions,
  ): Promise<SettlementOutcome> {
    const direction = transaction.ledgerDirectionFor(reference);
    const capacityFailure = this.checkBalanceCapacity(direction, transaction, wallet);
    if (capacityFailure !== undefined) {
      return this.reject(repositories, transaction, wallet, capacityFailure, options);
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

    await this.persistBalanceChange(
      repositories,
      transaction,
      wallet,
      entry,
      expectedVersion,
      options,
    );
    return { transaction, balance: wallet.balance, idempotentReplay: false };
  }

  private checkBalanceCapacity(
    direction: 'DEBIT' | 'CREDIT',
    transaction: WagerTransaction,
    wallet: Wallet,
  ): FailureCode | undefined {
    if (direction === 'DEBIT' && !wallet.canDebit(transaction.money)) {
      return transaction.isReversal() ? 'REVERSAL_WOULD_OVERDRAW' : 'INSUFFICIENT_BALANCE';
    }
    if (direction === 'CREDIT' && !wallet.canCredit(transaction.money)) {
      // A balance the database cannot store is a business outcome of the wallet's state, not a storage failure.
      return 'BALANCE_LIMIT_EXCEEDED';
    }
    return undefined;
  }

  private async persistBalanceChange(
    repositories: FinancialRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry,
    expectedVersion: number,
    options: SettlementOptions,
  ): Promise<void> {
    await this.save(repositories, transaction, options);
    await repositories.wallets.save(wallet, expectedVersion);
    await repositories.ledger.append(entry);

    const eventContext = this.eventContext(options);
    await repositories.outbox.enqueue(
      WagerTransactionProcessed.from(transaction, eventContext),
      WalletBalanceChanged.from(wallet, entry, { ...eventContext, eventId: this.context.newId() }),
    );
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
    const now = await repositories.databaseClock.now();
    if (!options.existing) {
      transaction.markPendingReference(
        new Date(now.getTime() + referenceRetryDelayMs(0)),
        wallet.balance,
      );
      await repositories.wagers.insert(transaction);
      await repositories.outbox.enqueue(
        WagerTransactionPendingReference.from(transaction, this.eventContext(options)),
      );
      return { transaction, balance: wallet.balance, idempotentReplay: false };
    }

    const { exhausted } = transaction.recordReferenceMiss(now);
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
