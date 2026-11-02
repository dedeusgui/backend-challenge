import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Money } from '../../../src/shared/domain/money';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransaction } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerCommandConsumer } from '../../../src/modules/messaging/application/inbound/wager-command-consumer';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import {
  closeTestSqs,
  createTestQueues,
  testSqsClient,
  type TestQueues,
} from '../support/sqs-test-queues';

const NOW = new Date('2026-07-29T15:00:00.000Z');

let database: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;
let openWallet: OpenWallet;

beforeAll(async () => {
  database = await createTestDatabase();
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
  openWallet = new OpenWallet({
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => NOW,
    newId: randomUUID,
  });
});

afterAll(async () => {
  try {
    await database?.drop();
  } finally {
    await closeTestSqs(sqs, queues);
  }
});

describe('consumer shutdown', () => {
  test('returns messages not yet attempted to the queue immediately', async () => {
    const playerId = `player-${randomUUID()}`;
    const { walletId } = await openWallet.execute({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const commandQueue = new SqsQueue(sqs, queues.commandQueueUrl);
    const deadLetters = new SqsQueue(sqs, queues.deadLetterQueueUrl);

    for (let index = 0; index < 3; index += 1) {
      const externalTransactionId = `transaction-${randomUUID()}`;
      await commandQueue.send(
        JSON.stringify({
          messageId: `msg-${randomUUID()}`,
          type: 'WagerTransactionRequested',
          occurredAt: NOW.toISOString(),
          data: {
            providerId: 'provider-a',
            externalTransactionId,
            idempotencyKey: `provider-a:${externalTransactionId}`,
            playerId,
            walletId,
            roundId: 'round-987',
            gameId: 'fortune-chimp',
            kind: 'LOSS',
            money: { amount: '25.00', currency: 'BRL' },
          },
        }),
        `group-${index}`,
        randomUUID(),
      );
    }

    let startFirstAttempt: (() => void) | undefined;
    let finishFirstAttempt: (() => void) | undefined;
    const firstAttemptStarted = new Promise<void>((resolve) => {
      startFirstAttempt = resolve;
    });
    const firstAttemptGate = new Promise<void>((resolve) => {
      finishFirstAttempt = resolve;
    });
    let attempts = 0;
    let stopping = false;
    const processor = new ProcessWagerTransaction({
      unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
      clock: () => NOW,
      newId: randomUUID,
    });
    const consumer = new WagerCommandConsumer({
      consumerName: 'wager-transactions',
      queue: commandQueue,
      deadLetters,
      process: {
        async execute(command) {
          attempts += 1;
          if (attempts === 1) {
            startFirstAttempt?.();
            await firstAttemptGate;
          }
          return processor.execute(command);
        },
      },
      visibilityTimeoutSeconds: 30,
    });

    const poll = consumer.pollOnce(() => stopping);
    await firstAttemptStarted;
    stopping = true;
    finishFirstAttempt?.();
    await poll;

    const redelivered = await commandQueue.receive({
      maxMessages: 10,
      waitSeconds: 0,
      visibilityTimeoutSeconds: 30,
    });
    expect(attempts).toBe(1);
    expect(redelivered).toHaveLength(2);
    for (const message of redelivered) {
      await commandQueue.acknowledge(message.receiptHandle);
    }
  });
});
