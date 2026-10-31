import type { ApplicationContext } from '../../../shared/application/application-context';
import {
  IdempotencyConflictError,
  MessagePayloadConflictError,
  WalletNotFoundError,
  ConcurrencyConflictError,
} from '../../../shared/application/application-errors';
import type { FinancialRepositories } from '../../../shared/application/ports/financial-unit-of-work.port';
import { DomainError } from '../../../shared/domain/domain-error';
import type { Money } from '../../../shared/domain/money';
import type { IntegrationEventContext } from '../../../shared/domain/integration-event';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed.event';
import type { Wallet } from '../../wallet/domain/wallet';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected.event';
import type { FailureCode } from '../domain/failure-code';
import { hashOf } from '../domain/wager-payload';
import { WagerTransaction, type CreateWagerTransactionProps } from '../domain/wager-transaction';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind';

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

export interface ProcessWagerOutcome {
  transaction: WagerTransaction;
  /** Balance after the operation, or the balance observed when it was rejected or is pending. */
  balance: Money;
  idempotentReplay: boolean;
}

/** Retries after losing a unique-identity race. Each retry starts from a rolled-back transaction. */
const MAX_CONCURRENCY_ATTEMPTS = 3;

/**
 * The only path that applies a wager operation. HTTP and SQS both call it.
 *
 * Order inside the transaction: lock the wallet, decide idempotency under that
 * lock, then write the transaction, the balance, the ledger, the inbox record and
 * the outbox events together. Duplicates of one wallet's operations are
 * serialized by the wallet lock, and the unique constraints back up the rest.
 */
export class ProcessWagerTransaction {
  constructor(private readonly context: ApplicationContext) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerOutcome> {
    if (!WagerTransaction.isExternallySubmittable(command.kind)) {
      throw new DomainError(
        'INVALID_TRANSACTION',
        `${command.kind} is internal and cannot be submitted`,
      );
    }
    const payloadHash = hashOf(businessFieldsOf(command));

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.context.unitOfWork.run((repositories) =>
          this.process(repositories, command, payloadHash),
        );
      } catch (error) {
        // The failed unit of work has rolled back, so no effect was committed. A retry reads the winner.
        if (error instanceof ConcurrencyConflictError && attempt < MAX_CONCURRENCY_ATTEMPTS) {
          continue;
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
        ? await this.settle(repositories, command, payloadHash, wallet)
        : this.replay(existing, payloadHash, wallet);

    if (command.inbound !== undefined && !inboundRecorded) {
      await this.recordInbound(repositories, command.inbound, payloadHash);
    }
    return outcome;
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

  private replay(
    existing: WagerTransaction,
    payloadHash: string,
    wallet: Wallet,
  ): ProcessWagerOutcome {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        `Idempotency key or external transaction ${existing.externalTransactionId} was used with a different payload`,
      );
    }
    return {
      transaction: existing,
      balance: existing.resultingBalance ?? wallet.balance,
      idempotentReplay: true,
    };
  }

  private async settle(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
    payloadHash: string,
    wallet: Wallet,
  ): Promise<ProcessWagerOutcome> {
    const transaction = WagerTransaction.create(this.newTransactionProps(command, payloadHash));
    const reference =
      command.referenceExternalTransactionId === undefined
        ? undefined
        : await repositories.wagers.findByExternalId(
            command.providerId,
            command.referenceExternalTransactionId,
          );

    const walletMismatch = transaction.walletMismatch(wallet);
    if (walletMismatch !== undefined) {
      return this.reject(repositories, command, transaction, wallet, walletMismatch);
    }

    const evaluation = transaction.evaluateReference(reference);
    if (evaluation.outcome === 'WAIT') {
      return this.holdForReference(repositories, command, transaction, wallet);
    }
    if (evaluation.outcome === 'REJECT') {
      return this.reject(repositories, command, transaction, wallet, evaluation.code);
    }

    if (
      reference !== undefined &&
      transaction.isReversal() &&
      (await repositories.wagers.hasProcessedReversal(reference.id, transaction.kind))
    ) {
      return this.reject(repositories, command, transaction, wallet, 'REFERENCE_ALREADY_REVERSED');
    }

    if (!transaction.affectsBalance()) {
      return this.finishWithoutBalanceChange(repositories, command, transaction, reference, wallet);
    }
    return this.applyBalanceChange(repositories, command, transaction, reference, wallet);
  }

  private async applyBalanceChange(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    wallet: Wallet,
  ): Promise<ProcessWagerOutcome> {
    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === 'DEBIT' && !wallet.canDebit(transaction.money)) {
      const code: FailureCode = transaction.isReversal()
        ? 'REVERSAL_WOULD_OVERDRAW'
        : 'INSUFFICIENT_BALANCE';
      return this.reject(repositories, command, transaction, wallet, code);
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

    await repositories.wagers.insert(transaction);
    await repositories.wallets.save(wallet, expectedVersion);
    await repositories.ledger.append(entry);

    const eventContext = this.eventContext(command);
    await repositories.outbox.enqueue(WagerTransactionProcessed.from(transaction, eventContext));
    await repositories.outbox.enqueue(
      WalletBalanceChanged.from(wallet, entry, { ...eventContext, eventId: this.context.newId() }),
    );
    return { transaction, balance: wallet.balance, idempotentReplay: false };
  }

  private async finishWithoutBalanceChange(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    wallet: Wallet,
  ): Promise<ProcessWagerOutcome> {
    transaction.markProcessed({
      referenceTransactionId: reference?.id,
      resultingBalance: wallet.balance,
      at: this.context.clock(),
    });
    await repositories.wagers.insert(transaction);
    await repositories.outbox.enqueue(
      WagerTransactionProcessed.from(transaction, this.eventContext(command)),
    );
    return { transaction, balance: wallet.balance, idempotentReplay: false };
  }

  private async reject(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
    transaction: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
  ): Promise<ProcessWagerOutcome> {
    transaction.reject({ code, observedBalance: wallet.balance });
    await repositories.wagers.insert(transaction);
    await repositories.outbox.enqueue(
      WagerTransactionRejected.from(transaction, this.eventContext(command)),
    );
    return { transaction, balance: wallet.balance, idempotentReplay: false };
  }

  private async holdForReference(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
    transaction: WagerTransaction,
    wallet: Wallet,
  ): Promise<ProcessWagerOutcome> {
    transaction.markPendingReference();
    await repositories.wagers.insert(transaction);
    await repositories.outbox.enqueue(
      WagerTransactionPendingReference.from(transaction, this.eventContext(command)),
    );
    return { transaction, balance: wallet.balance, idempotentReplay: false };
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

  private eventContext(command: ProcessWagerCommand): IntegrationEventContext {
    return {
      eventId: this.context.newId(),
      correlationId: command.correlationId,
      causationId: command.inbound?.messageId,
      occurredAt: this.context.clock(),
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
