import type { ApplicationContext } from '../../../shared/application/application-context';
import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  MessagePayloadConflictError,
  WalletNotFoundError,
} from '../../../shared/application/application-errors';
import type { FinancialRepositories } from '../../../shared/application/ports/financial-unit-of-work.port';
import { DomainError } from '../../../shared/domain/domain-error';
import type { Money } from '../../../shared/domain/money';
import { NO_METRICS, type MetricsSink } from '../../../shared/observability/metrics';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import type { Wallet } from '../../wallet/domain/wallet';
import { hashOf } from '../domain/wager-payload';
import { WagerTransaction, type CreateWagerTransactionProps } from '../domain/wager-transaction';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { TransactionSettlement, type SettlementOutcome } from './transaction-settlement';

/** Queue metadata for a command that arrived from SQS. The inbox deduplicates on it. */
export interface InboundMessage {
  consumerName: string;
  messageId: string;
}

/** The business command. The same command is produced by the HTTP controller and the SQS consumer. */
export interface ProcessWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  correlationId: string;
  inbound?: InboundMessage;
}

export type ProcessWagerOutcome = SettlementOutcome;

/** Retries after losing a unique-identity race. Each retry starts from a rolled-back transaction. */
const MAX_CONCURRENCY_ATTEMPTS = 3;

/**
 * The only entry point for new wager operations. HTTP and SQS both call it.
 *
 * It handles what is specific to an arriving request: the wallet lock, idempotency under that
 * lock, the inbox record and the retry on a lost unique-identity race. The financial decision
 * is delegated to TransactionSettlement, which the reference worker also uses.
 */
export class ProcessWagerTransaction {
  private readonly settlement: TransactionSettlement;
  private readonly metrics: MetricsSink;

  constructor(private readonly context: ApplicationContext) {
    this.settlement = new TransactionSettlement(context);
    this.metrics = context.metrics ?? NO_METRICS;
  }

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerOutcome> {
    if (!WagerTransaction.isExternallySubmittable(command.kind)) {
      throw new DomainError(
        'INVALID_TRANSACTION',
        `${command.kind} is internal and cannot be submitted`,
      );
    }
    const payloadHash = hashOf(businessFieldsOf(command));

    const started = performance.now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        const outcome = await this.inTransaction(command, payloadHash);
        // A replay is not a new transaction, so it is counted by idempotent_replays_total only.
        if (!outcome.idempotentReplay) {
          this.metrics.increment('transactions_total', { status: outcome.transaction.status });
        }
        const elapsed = performance.now() - started;
        this.metrics.observe('processing_latency_ms', elapsed);
        if (outcome.idempotentReplay) {
          this.metrics.observe('replay_latency_ms', elapsed);
        }
        return outcome;
      } catch (error) {
        // The failed unit of work has rolled back, so no effect was committed. A retry reads the winner.
        if (error instanceof ConcurrencyConflictError) {
          this.metrics.increment('concurrency_conflicts_total');
          if (attempt < MAX_CONCURRENCY_ATTEMPTS) {
            continue;
          }
        }
        throw error;
      }
    }
  }

  /**
   * Runs the unit of work and times its three phases: the wait for a connection and BEGIN, the work
   * inside the transaction (lock, decision and writes), and the COMMIT. Replays take the same phases,
   * without the lock.
   */
  private async inTransaction(
    command: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<ProcessWagerOutcome> {
    const requested = performance.now();
    let worked = requested;
    const outcome = await this.context.unitOfWork.run(async (repositories) => {
      const working = performance.now();
      this.metrics.observe('transaction_begin_ms', working - requested);
      try {
        return await this.process(repositories, command, payloadHash);
      } finally {
        worked = performance.now();
        this.metrics.observe('transaction_work_ms', worked - working);
      }
    });
    this.metrics.observe('transaction_commit_ms', performance.now() - worked);
    return outcome;
  }

  private async process(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<ProcessWagerOutcome> {
    const inboundRecorded = await this.isInboundRecorded(repositories, command, payloadHash);

    // A stored transaction is answered without the wallet lock. Its payload never changes, and a replay
    // writes nothing except, for a new delivery, its inbox record.
    const stored = await this.findStored(repositories, command);
    if (stored !== undefined) {
      return this.answerReplay(repositories, command, stored, payloadHash, inboundRecorded);
    }

    // A new transaction takes the wallet lock first, then looks again. A request that committed the
    // same identity while this one waited is a replay, not a second effect. Without this second look,
    // the waiting request would insert, collide on the unique key and retry, and under load it could use
    // up its attempts and answer 503 to an identical request.
    const lockRequested = performance.now();
    const wallet = await repositories.wallets.findForUpdate(command.walletId);
    this.metrics.observe('wallet_lock_wait_ms', performance.now() - lockRequested);
    if (wallet === undefined) {
      throw new WalletNotFoundError(command.walletId);
    }
    const committed = await this.findStored(repositories, command);
    if (committed !== undefined) {
      // The same message may have been recorded while this one waited. Its inbox row is then the winner's,
      // and a second insert would collide with it, roll back a finished replay, and count a lost race.
      const recorded =
        inboundRecorded || (await this.isInboundRecorded(repositories, command, payloadHash));
      return this.answerReplay(repositories, command, committed, payloadHash, recorded);
    }

    const outcome = await this.settleNew(repositories, command, payloadHash, wallet);
    if (command.inbound !== undefined && !inboundRecorded) {
      await this.recordInbound(repositories, command.inbound, payloadHash);
    }
    return outcome;
  }

  /** The idempotency key is the source of truth, and the external id is the same identity under another key. */
  private findStored(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
  ): Promise<WagerTransaction | undefined> {
    return repositories.wagers.findByIdentity(
      command.providerId,
      command.idempotencyKey,
      command.externalTransactionId,
    );
  }

  private async answerReplay(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
    existing: WagerTransaction,
    payloadHash: string,
    inboundRecorded: boolean,
  ): Promise<ProcessWagerOutcome> {
    const outcome = this.replay(existing, payloadHash);
    if (command.inbound !== undefined && !inboundRecorded) {
      await this.recordInbound(repositories, command.inbound, payloadHash);
    }
    return outcome;
  }

  private settleNew(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
    payloadHash: string,
    wallet: Wallet,
  ): Promise<ProcessWagerOutcome> {
    const transaction = WagerTransaction.create(this.newTransactionProps(command, payloadHash));
    return this.settlement.settle(repositories, transaction, wallet, {
      existing: false,
      correlationId: command.correlationId,
      causationId: command.inbound?.messageId,
    });
  }

  /** Returns true for a duplicate delivery. A reused message id with a different payload is a permanent error. */
  private async isInboundRecorded(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<boolean> {
    if (command.inbound === undefined) {
      return false;
    }
    const received = await repositories.inbox.find(
      command.inbound.consumerName,
      command.inbound.messageId,
    );
    if (received === undefined) {
      return false;
    }
    if (!received.matchesPayload(payloadHash)) {
      throw new MessagePayloadConflictError(command.inbound.messageId);
    }
    return true;
  }

  private replay(existing: WagerTransaction, payloadHash: string): ProcessWagerOutcome {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        `Idempotency key or external transaction ${existing.externalTransactionId} was used with a different payload`,
      );
    }
    this.metrics.increment('idempotent_replays_total');
    const balance = existing.resultingBalance;
    if (balance === undefined) {
      // Every stored transaction keeps the balance it reported, and the database enforces it. Without it a replay is wrong.
      throw new Error(`Transaction ${existing.id} has no balance to replay`);
    }
    return { transaction: existing, balance, idempotentReplay: true };
  }

  private async recordInbound(
    repositories: FinancialRepositories,
    inbound: InboundMessage,
    payloadHash: string,
  ): Promise<void> {
    const at = this.context.clock();
    const message = InboxMessage.receive({
      consumerName: inbound.consumerName,
      messageId: inbound.messageId,
      payloadHash,
      receivedAt: at,
    });
    message.markProcessed(at);
    await repositories.inbox.insert(message);
  }

  private newTransactionProps(
    command: ProcessWagerCommand,
    payloadHash: string,
  ): CreateWagerTransactionProps {
    return {
      id: this.context.newId(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: this.context.clock(),
    };
  }
}

function businessFieldsOf(command: ProcessWagerCommand) {
  return {
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money,
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  };
}
