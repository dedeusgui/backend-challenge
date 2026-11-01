import { createHash } from 'node:crypto';
import type {
  ProcessWagerCommand,
  ProcessWagerOutcome,
} from '../../../wagering/application/process-wager-transaction.use-case';
import type { MessageQueue, ReceivedMessage } from '../ports/message-queue';
import { classifyCommandFailure } from '../../../../shared/application/failure-classification';
import { parseWagerCommandMessage } from './wager-command-message';
import { NO_METRICS, type MetricsSink } from '../../../../shared/observability/metrics';
import {
  describeError,
  SILENT_LOGGER,
  type ErrorFields,
  type OperationLogger,
} from '../../../../shared/observability/structured-log';

export interface CommandProcessor {
  execute(command: ProcessWagerCommand): Promise<ProcessWagerOutcome>;
}

interface WagerCommandConsumerOptions {
  consumerName: string;
  queue: MessageQueue;
  deadLetters: MessageQueue;
  process: CommandProcessor;
  visibilityTimeoutSeconds: number;
  /**
   * How long a processing may keep its message invisible to other consumers. Past this, the message is released
   * and may be delivered again, so a processor that hangs cannot hold a message forever.
   */
  holdLimitSeconds?: number;
  metrics?: MetricsSink;
  logger?: OperationLogger;
}

const BATCH_SIZE = 10;
const MAX_RETRY_DELAY_SECONDS = 300;
const DEFAULT_HOLD_LIMIT_SECONDS = 300;
const DEAD_LETTER_GROUP = 'dead-letter';

type Disposition = 'APPLIED' | 'DEAD' | 'RETRY';

interface Attempt {
  disposition: Disposition;
  messageId: string | undefined;
  /** Class and code of the failure that decided the disposition. Absent when the command applied. */
  failure?: ErrorFields;
}

/**
 * Consumes wager commands. The same ProcessWagerTransaction use case as HTTP does
 * the work, and a message is acknowledged only after its transaction has committed.
 * Permanent failures go to the dead-letter queue. Transient failures are redelivered
 * with backoff. After repeated deliveries, the broker redrive policy takes over.
 */
export class WagerCommandConsumer {
  private readonly metrics: MetricsSink;
  private readonly logger: OperationLogger;

  constructor(private readonly options: WagerCommandConsumerOptions) {
    this.metrics = options.metrics ?? NO_METRICS;
    this.logger = options.logger ?? SILENT_LOGGER;
  }

  /** Returns how many messages left the command queue (applied or dead-lettered). */
  async pollOnce(isStopping: () => boolean = () => false): Promise<number> {
    const { queue, visibilityTimeoutSeconds } = this.options;
    const messages = await queue.receive({
      maxMessages: BATCH_SIZE,
      waitSeconds: 1,
      visibilityTimeoutSeconds,
    });

    let removed = 0;
    for (const [index, message] of messages.entries()) {
      if (isStopping()) {
        await this.releaseUnattempted(messages.slice(index));
        break;
      }
      // The first message starts inside the window that receive set. Each later one may wait behind the
      // messages before it, so every message still waiting gets a full window again, from now.
      if (index > 0) {
        await this.keepWaitingInvisible(messages.slice(index));
      }
      if (await this.settle(message)) {
        removed += 1;
      }
    }
    return removed;
  }

  private keepWaitingInvisible(waiting: readonly ReceivedMessage[]): Promise<void> {
    return this.options.queue.extendVisibility(
      waiting.map((message) => message.receiptHandle),
      this.options.visibilityTimeoutSeconds,
    );
  }

  private releaseUnattempted(waiting: readonly ReceivedMessage[]): Promise<void> {
    return this.options.queue.extendVisibility(
      waiting.map((message) => message.receiptHandle),
      0,
    );
  }

  private async settle(message: ReceivedMessage): Promise<boolean> {
    const { queue, deadLetters } = this.options;
    const { disposition, messageId, failure } = await this.attempt(message);
    this.metrics.increment('commands_total', { result: disposition });
    this.logger({ operation: 'command.settle', status: disposition, messageId, ...failure });

    if (disposition === 'APPLIED') {
      // Outside the attempt on purpose: a failure here must leave the message for redelivery.
      await queue.acknowledge(message.receiptHandle);
      return true;
    }
    if (disposition === 'DEAD') {
      await deadLetters.send(
        message.body,
        DEAD_LETTER_GROUP,
        deadLetterDeduplicationId(message.body),
      );
      await queue.acknowledge(message.receiptHandle);
      return true;
    }
    this.metrics.increment('retries_total', { subsystem: 'command' });
    await queue.changeVisibility(message.receiptHandle, retryDelaySeconds(message.receiveCount));
    return false;
  }

  /** `messageId` is read from the body when the body parses, so logs name the message that was handled. */
  private async attempt(message: ReceivedMessage): Promise<Attempt> {
    let command: ProcessWagerCommand;
    try {
      command = parseWagerCommandMessage(message.body, this.options.consumerName);
    } catch (error) {
      return { disposition: 'DEAD', messageId: undefined, failure: describeError(error) };
    }
    const messageId = command.inbound?.messageId;

    try {
      await this.processHeld(message, command);
      return { disposition: 'APPLIED', messageId };
    } catch (error) {
      const disposition = classifyCommandFailure(error) === 'PERMANENT' ? 'DEAD' : 'RETRY';
      return { disposition, messageId, failure: describeError(error) };
    }
  }

  /**
   * Runs the command while its message stays invisible. The window is renewed every third of its length, until the
   * hold limit. A renewal the broker refuses ends the renewals, because the message is no longer this consumer's.
   * The command still runs to its end, and the transaction identity keeps its effect to one.
   */
  private async processHeld(message: ReceivedMessage, command: ProcessWagerCommand): Promise<void> {
    const { queue, visibilityTimeoutSeconds } = this.options;
    const holdLimitMs = (this.options.holdLimitSeconds ?? DEFAULT_HOLD_LIMIT_SECONDS) * 1000;
    const releaseAt = Date.now() + holdLimitMs;
    const messageId = command.inbound?.messageId;
    let renewals: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      if (Date.now() >= releaseAt) {
        clearInterval(timer);
        return;
      }
      renewals = renewals
        .then(() => queue.changeVisibility(message.receiptHandle, visibilityTimeoutSeconds))
        .catch((error: unknown) => {
          clearInterval(timer);
          this.logger({
            operation: 'command.hold',
            status: 'RENEWAL_REFUSED',
            messageId,
            ...describeError(error),
          });
        });
    }, renewalIntervalMs(visibilityTimeoutSeconds));
    try {
      await this.options.process.execute(command);
    } finally {
      clearInterval(timer);
      await renewals;
    }
  }
}

/** A third of the window, so one renewal can be lost before the window ends. At least a tenth of a second. */
function renewalIntervalMs(visibilityTimeoutSeconds: number): number {
  return Math.max(100, Math.floor((visibilityTimeoutSeconds * 1000) / 3));
}

/**
 * The same body always gets the same id. A dead-letter send that a crash repeats on redelivery is then
 * accepted once inside the broker's five-minute deduplication window, so the dead-letter queue keeps one
 * copy of it. After the window, a repeated send is a new copy, so a message is never lost.
 */
export function deadLetterDeduplicationId(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Exponential backoff for redelivery: 2 s, 4 s, 8 s, ... capped at 5 minutes. */
export function retryDelaySeconds(receiveCount: number): number {
  return Math.min(2 ** receiveCount, MAX_RETRY_DELAY_SECONDS);
}
