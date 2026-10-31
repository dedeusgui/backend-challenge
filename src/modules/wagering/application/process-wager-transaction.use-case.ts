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
        const outcome = await this.context.unitOfWork.run((repositories) =>
          this.process(repositories, command, payloadHash),
        );
        // A replay is not a new transaction, so it is counted by idempotent_replays_total only.
        if (!outcome.idempotentReplay) {
          this.metrics.increment('transactions_total', { status: outcome.transaction.status });
        }
        this.metrics.observe('processing_latency_ms', performance.now() - started);
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

  private async process(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<ProcessWagerOutcome> {
    const wallet = await repositories.wallets.findForUpdate(command.walletId);
    if (wallet === undefined) {
      throw new WalletNotFoundError(command.walletId);
    }

    const inboundRecorded = await this.isInboundRecorded(repositories, command, payloadHash);
    const existing =
      (await repositories.wagers.findByIdempotencyKey(
        command.providerId,
        command.idempotencyKey,
      )) ??
      (await repositories.wagers.findByExternalId(
        command.providerId,
        command.externalTransactionId,
      ));

    const outcome =
      existing === undefined
        ? await this.settleNew(repositories, command, payloadHash, wallet)
        : this.replay(existing, payloadHash);

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
