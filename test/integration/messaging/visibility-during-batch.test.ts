import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
  type ProcessWagerOutcome,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import {
  NO_FAULTS,
  WagerCommandConsumer,
} from '../../../src/modules/messaging/application/wager-command-consumer';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { MetricsRegistry } from '../../../src/shared/observability/metrics';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, testSqsClient, type TestQueues } from '../support/sqs-test-queues';

/**
 * A received batch is processed one message at a time. A message that waits for its turn must not
 * become visible again while another consumer can take it: the second consumer would then process a
 * message that is still in flight, and the broker counts one more delivery against its redrive limit.
 *
 * The timings are chosen so that the first consumer's third message would expire at 2 s, while the
 * first consumer is still on its second message, and the second consumer polls at 2.2 s.
 */

const VISIBILITY_SECONDS = 2;
const STALL_MS = 1_200;
const SECOND_CONSUMER_DELAY_MS = 2_200;

let database: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;
let processWager: ProcessWagerTransaction;
let openWallet: OpenWallet;

beforeAll(async () => {
  database = await createTestDatabase();
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
  const dependencies = {
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => new Date(),
    newId: randomUUID,
  };
  processWager = new ProcessWagerTransaction(dependencies);
  openWallet = new OpenWallet(dependencies);
});

afterAll(async () => {
  await database.drop();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function messageBody(messageId: string): Promise<{ body: string; group: string }> {
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  const externalTransactionId = `tx-${randomUUID()}`;
  return {
    group: walletId,
    body: JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId,
        walletId,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
    }),
  };
}

describe('visibility of a batch that is still being processed', () => {
  test('a message of a batch is not delivered to a second consumer while the first is processing it', async () => {
    const commands = new SqsQueue(sqs, queues.commandQueueUrl);
    const messageIds = [1, 2, 3].map(() => `msg-${randomUUID()}`);
    for (const messageId of messageIds) {
      const { body, group } = await messageBody(messageId);
      await commands.send(body, group, randomUUID());
    }

    // Every hand-off to the use case is counted, whichever consumer makes it.
    const executions = new Map<string, number>();
    const counted = (stallMs: number) => ({
      execute: async (command: ProcessWagerCommand): Promise<ProcessWagerOutcome> => {
        const id = command.inbound?.messageId ?? '';
        executions.set(id, (executions.get(id) ?? 0) + 1);
        if (stallMs > 0) {
          await sleep(stallMs);
        }
        return processWager.execute(command);
      },
    });
    const slowProcess = counted(STALL_MS);
    const fastProcess = counted(0);
    const metrics = new MetricsRegistry();
    const first = new WagerCommandConsumer({
      consumerName: 'wager-transactions',
      queue: new SqsQueue(sqs, queues.commandQueueUrl),
      deadLetters: new SqsQueue(sqs, queues.deadLetterQueueUrl),
      process: slowProcess,
      visibilityTimeoutSeconds: VISIBILITY_SECONDS,
      faults: NO_FAULTS,
      metrics,
    });
    const second = new WagerCommandConsumer({
      consumerName: 'wager-transactions',
      queue: new SqsQueue(sqs, queues.commandQueueUrl),
      deadLetters: new SqsQueue(sqs, queues.deadLetterQueueUrl),
      process: fastProcess,
      visibilityTimeoutSeconds: VISIBILITY_SECONDS,
      faults: NO_FAULTS,
      metrics,
    });

    const firstPass = first.pollOnce();
    await sleep(SECOND_CONSUMER_DELAY_MS);
    const secondPass = await second.pollOnce();
    await firstPass;

    expect(secondPass).toBe(0);
    for (const messageId of messageIds) {
      expect(executions.get(messageId)).toBe(1);
    }
  }, 30_000);
});
