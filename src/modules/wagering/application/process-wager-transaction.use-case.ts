import type { ApplicationContext } from '../../../shared/application/application-context';
import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  MessagePayloadConflictError,
  WalletNotFoundError,
} from '../../../shared/application/application-errors';
import type { FinancialRepositories } from '../../../shared/application/ports/financial-unit-of-work';
import { DomainError } from '../../../shared/domain/domain-error';
import type { Money } from '../../../shared/domain/money';
import { NO_METRICS, type MetricsSink } from '../../../shared/observability/metrics';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import type { Wallet } from '../../wallet/domain/wallet';
import { hashOf } from '../domain/wager-payload';
import { wagerMessageFingerprint } from '../domain/wager-payload-hash';
import { WagerTransaction, type CreateWagerTransactionProps } from '../domain/wager-transaction';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { TransactionSettlement, type SettlementOutcome } from './transaction-settlement';

/** Queue metadata for a command that arrived from SQS. The inbox deduplicates on it. */
interface InboundMessage {
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

/**
 * The two hashes of a command. `payloadHash` is the identity of the transaction: the same business payload
 * under the same key or external id is a replay. `messageFingerprint` exists only for a queue message, and
 * also covers its idempotencyKey, since the messageId identifies one exact content.
 */
interface Hashes {
  readonly payloadHash: string;
  readonly messageFingerprint: string | undefined;
}

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
    this.assertSubmittable(command.kind);
    const hashes = hashesOf(command);

    const started = performance.now();
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.executeAttempt(command, hashes, started, attempt);
      if (outcome !== undefined) {
        return outcome;
      }
    }
  }

  private async executeAttempt(
    command: ProcessWagerCommand,
    hashes: Hashes,
    started: number,
    attempt: number,
  ): Promise<ProcessWagerOutcome | undefined> {
    try {
      const outcome = await this.inTransaction(command, hashes);
      this.recordOutcomeMetrics(outcome, started);
      return outcome;
    } catch (error) {
      this.rethrowUnlessRetriableConflict(error, attempt);
      return undefined;
    }
  }

  private assertSubmittable(kind: WagerTransactionKind): void {
    if (!WagerTransaction.isExternallySubmittable(kind)) {
      throw new DomainError('INVALID_TRANSACTION', `${kind} is internal and cannot be submitted`);
    }
  }

  private recordOutcomeMetrics(outcome: ProcessWagerOutcome, started: number): void {
    // A replay is not a new transaction, so it is counted by idempotent_replays_total only.
    if (!outcome.idempotentReplay) {
      this.metrics.increment('transactions_total', { status: outcome.transaction.status });
    }
    const elapsed = performance.now() - started;
    this.metrics.observe('processing_latency_ms', elapsed);
    if (outcome.idempotentReplay) {
      this.metrics.observe('replay_latency_ms', elapsed);
    }
  }

  private rethrowUnlessRetriableConflict(error: unknown, attempt: number): void {
    if (!this.canRetryConflict(error, attempt)) {
      throw error;
    }
  }

  private canRetryConflict(error: unknown, attempt: number): boolean {
    // The failed unit of work has rolled back, so no effect was committed. A retry reads the winner.
    if (error instanceof ConcurrencyConflictError) {
      this.metrics.increment('concurrency_conflicts_total');
      return attempt < MAX_CONCURRENCY_ATTEMPTS;
    }
    return false;
  }

  /**
   * Runs the unit of work and times its three phases: the wait for a connection and BEGIN, the work
   * inside the transaction (lock, decision and writes), and the COMMIT. Replays take the same phases,
   * without the lock.
   */
  private async inTransaction(
    command: ProcessWagerCommand,
    hashes: Hashes,
  ): Promise<ProcessWagerOutcome> {
    const requested = performance.now();
    let worked = requested;
    const outcome = await this.context.unitOfWork.run(async (repositories) => {
      const working = performance.now();
      this.metrics.observe('transaction_begin_ms', working - requested);
      try {
        return await this.process(repositories, command, hashes);
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
    hashes: Hashes,
  ): Promise<ProcessWagerOutcome> {
    const inboundRecorded = await this.isInboundRecorded(repositories, command, hashes);

    // A stored transaction is answered without the wallet lock. Its payload never changes, and a replay
    // writes nothing except, for a new delivery, its inbox record.
    const stored = await this.findStored(repositories, command);
    if (stored !== undefined) {
      return this.answerReplay(repositories, command, stored, hashes, inboundRecorded);
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
        inboundRecorded || (await this.isInboundRecorded(repositories, command, hashes));
      return this.answerReplay(repositories, command, committed, hashes, recorded);
    }

    const outcome = await this.settleNew(repositories, command, hashes.payloadHash, wallet);
    if (command.inbound !== undefined && !inboundRecorded) {
      await this.recordInbound(repositories, command.inbound, hashes.messageFingerprint);
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
    hashes: Hashes,
    inboundRecorded: boolean,
  ): Promise<ProcessWagerOutcome> {
    const outcome = this.replay(existing, hashes.payloadHash);
    if (command.inbound !== undefined && !inboundRecorded) {
      await this.recordInbound(repositories, command.inbound, hashes.messageFingerprint);
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

  /**
   * Returns true for a duplicate delivery. A reused message id whose content differs is a permanent error.
   * A row recorded before message fingerprints existed holds the payload hash alone, and is still compared
   * on the business fields only, as it was then.
   */
  private async isInboundRecorded(
    repositories: FinancialRepositories,
    command: ProcessWagerCommand,
    hashes: Hashes,
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
    const sameContent =
      received.matchesPayload(hashes.messageFingerprint ?? hashes.payloadHash) ||
      received.matchesPayload(hashes.payloadHash);
    if (!sameContent) {
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
    fingerprint: string | undefined,
  ): Promise<void> {
    if (fingerprint === undefined) {
      // Only a command that came from the queue has an inbound record, and such a command always has a fingerprint.
      throw new Error(`Inbound message ${inbound.messageId} has no fingerprint`);
    }
    const at = this.context.clock();
    const message = InboxMessage.receive({
      consumerName: inbound.consumerName,
      messageId: inbound.messageId,
      payloadHash: fingerprint,
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

function hashesOf(command: ProcessWagerCommand): Hashes {
  const payload = businessFieldsOf(command);
  const payloadHash = hashOf(payload);
  return {
    payloadHash,
    messageFingerprint:
      command.inbound === undefined
        ? undefined
        : wagerMessageFingerprint(payload, command.idempotencyKey),
  };
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
