import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  WagerCommandConsumer,
  type CommandProcessor,
} from '../../../../src/modules/messaging/application/inbound/wager-command-consumer';
import type {
  MessageQueue,
  ReceivedMessage,
  ReceiveOptions,
} from '../../../../src/modules/messaging/application/ports/message-queue';
import { RequestValidationError } from '../../../../src/shared/validation/request-validation';
import type { OperationLog } from '../../../../src/shared/observability/structured-log';

/**
 * The hold of a message while its command runs: renewals of the visibility window while the command runs, a
 * refused renewal that ends them, and the hold limit. The command here ends by rejecting with a permanent error,
 * so the message leaves the queue through the dead-letter path, which needs no transaction outcome.
 */

const HANDLE = 'handle-1';
const DELIVERY: ReceivedMessage = {
  receiptHandle: HANDLE,
  receiveCount: 1,
  body: JSON.stringify({
    messageId: `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'tx-1',
      idempotencyKey: 'provider-a:tx-1',
      playerId: randomUUID(),
      walletId: randomUUID(),
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    },
  }),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A queue that delivers its messages once, records the visibility changes, and can refuse them. */
class FakeQueue implements MessageQueue {
  readonly acknowledged: string[] = [];
  readonly sent: string[] = [];
  visibilityChanges = 0;

  constructor(
    private pending: ReceivedMessage[],
    private readonly refuseVisibility: boolean,
  ) {}

  async send(body: string): Promise<void> {
    this.sent.push(body);
  }

  async receive(_options: ReceiveOptions): Promise<ReceivedMessage[]> {
    const delivered = this.pending;
    this.pending = [];
    return delivered;
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    this.acknowledged.push(receiptHandle);
  }

  async changeVisibility(_receiptHandle: string, _seconds: number): Promise<void> {
    this.visibilityChanges += 1;
    if (this.refuseVisibility) {
      throw new Error('ReceiptHandleIsInvalid');
    }
  }

  async extendVisibility(): Promise<void> {
    throw new Error('not used: a single message is held by its own renewals');
  }
}

/** Takes `ms` to run, then rejects permanently, so the message is dead-lettered and leaves the queue. */
function slowThenRejected(ms: number): CommandProcessor {
  return {
    execute: async () => {
      await sleep(ms);
      throw new RequestValidationError('rejected after the hold');
    },
  };
}

function consumerFor(
  queue: FakeQueue,
  process: CommandProcessor,
  options: { holdLimitSeconds?: number; logs?: OperationLog[] } = {},
): WagerCommandConsumer {
  return new WagerCommandConsumer({
    consumerName: 'wager-transactions',
    queue,
    deadLetters: new FakeQueue([], false),
    process,
    visibilityTimeoutSeconds: 1,
    holdLimitSeconds: options.holdLimitSeconds,
    logger: options.logs ? (entry) => options.logs?.push(entry) : undefined,
  });
}

describe('a message is held while its command runs', () => {
  test('a renewal the broker refuses ends the renewals, is logged, and the message still leaves the queue', async () => {
    const queue = new FakeQueue([DELIVERY], true);
    const logs: OperationLog[] = [];
    const consumer = consumerFor(queue, slowThenRejected(1_000), { logs });

    expect(await consumer.pollOnce()).toBe(1);

    // One refused renewal, and none after it: the window is not renewed once the broker has refused it.
    expect(queue.visibilityChanges).toBe(1);
    expect(logs.filter((entry) => entry.status === 'RENEWAL_REFUSED')).toHaveLength(1);
    expect(queue.acknowledged).toEqual([HANDLE]);
  });

  test('renewals continue while the command runs, and stop when it completes', async () => {
    const queue = new FakeQueue([DELIVERY], false);
    const consumer = consumerFor(queue, slowThenRejected(1_000));

    expect(await consumer.pollOnce()).toBe(1);
    const atCompletion = queue.visibilityChanges;
    await sleep(700);

    expect(atCompletion).toBeGreaterThanOrEqual(2);
    expect(queue.visibilityChanges).toBe(atCompletion);
  });

  test('renewals stop at the hold limit, and the message is released while the command still runs', async () => {
    const queue = new FakeQueue([DELIVERY], false);
    const consumer = consumerFor(queue, slowThenRejected(1_500), { holdLimitSeconds: 0.6 });

    const pass = consumer.pollOnce();
    await sleep(900);
    const atLimit = queue.visibilityChanges;
    await pass;

    expect(atLimit).toBeGreaterThanOrEqual(1);
    expect(queue.visibilityChanges).toBe(atLimit);
  });
});
