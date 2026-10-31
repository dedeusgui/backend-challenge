import { randomUUID } from 'node:crypto';
import type {
  ProcessWagerCommand,
  ProcessWagerOutcome,
} from '../../wagering/application/process-wager-transaction.use-case';
import type { MessageQueue, ReceivedMessage } from './message-queue.port';
import { classifyCommandFailure } from './failure-classification';
import { parseWagerCommandMessage } from './wager-command-message';
import { NO_METRICS, type MetricsSink } from '../../../shared/observability/metrics';
import { SILENT_LOGGER, type OperationLogger } from '../../../shared/observability/structured-log';

/** Test-only seam at the point where a crash would hurt most. The production default does nothing. */
export interface ConsumerFaults {
  beforeAcknowledge(message: ReceivedMessage): Promise<void>;
}

export const NO_FAULTS: ConsumerFaults = {
  beforeAcknowledge: async () => undefined,
};

export interface CommandProcessor {
  execute(command: ProcessWagerCommand): Promise<ProcessWagerOutcome>;
}

export interface WagerCommandConsumerOptions {
  consumerName: string;
  queue: MessageQueue;
  deadLetters: MessageQueue;
  process: CommandProcessor;
  visibilityTimeoutSeconds: number;
  faults: ConsumerFaults;
  metrics?: MetricsSink;
  logger?: OperationLogger;
}

const BATCH_SIZE = 10;
const MAX_RETRY_DELAY_SECONDS = 300;
const DEAD_LETTER_GROUP = 'dead-letter';

type Disposition = 'APPLIED' | 'DEAD' | 'RETRY';

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
  async pollOnce(): Promise<number> {
    const { queue, visibilityTimeoutSeconds } = this.options;
    const messages = await queue.receive({
      maxMessages: BATCH_SIZE,
      waitSeconds: 1,
      visibilityTimeoutSeconds,
    });

    let removed = 0;
    for (const message of messages) {
      if (await this.settle(message)) {
        removed += 1;
      }
    }
    return removed;
  }

  private async settle(message: ReceivedMessage): Promise<boolean> {
    const { queue, deadLetters, faults } = this.options;
    const { disposition, messageId } = await this.attempt(message);
    this.metrics.increment('commands_total', { result: disposition });
    this.logger({ operation: 'command.settle', status: disposition, messageId });

    if (disposition === 'APPLIED') {
      // Outside the attempt on purpose: a crash here must leave the message for redelivery.
      await faults.beforeAcknowledge(message);
      await queue.acknowledge(message.receiptHandle);
      return true;
    }
    if (disposition === 'DEAD') {
      await deadLetters.send(message.body, DEAD_LETTER_GROUP, randomUUID());
      await queue.acknowledge(message.receiptHandle);
      return true;
    }
    await queue.changeVisibility(message.receiptHandle, retryDelaySeconds(message.receiveCount));
    return false;
  }

  /** `messageId` is read from the body when the body parses, so logs name the message that was handled. */
  private async attempt(
    message: ReceivedMessage,
  ): Promise<{ disposition: Disposition; messageId: string | undefined }> {
    let command: ProcessWagerCommand;
    try {
      command = parseWagerCommandMessage(message.body, this.options.consumerName);
    } catch {
      return { disposition: 'DEAD', messageId: undefined };
    }
    const messageId = command.inbound?.messageId;

    try {
      await this.options.process.execute(command);
      return { disposition: 'APPLIED', messageId };
    } catch (error) {
      const disposition = classifyCommandFailure(error) === 'PERMANENT' ? 'DEAD' : 'RETRY';
      return { disposition, messageId };
    }
  }
}

/** Exponential backoff for redelivery: 2 s, 4 s, 8 s, ... capped at 5 minutes. */
export function retryDelaySeconds(receiveCount: number): number {
  return Math.min(2 ** receiveCount, MAX_RETRY_DELAY_SECONDS);
}
