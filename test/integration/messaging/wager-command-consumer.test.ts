import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { ConcurrencyConflictError } from '../../../src/shared/application/application-errors';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransaction } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import {
  WagerCommandConsumer,
  NO_FAULTS,
  type ConsumerFaults,
} from '../../../src/modules/messaging/application/wager-command-consumer';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, testSqsClient, type TestQueues } from '../support/sqs-test-queues';

const NOW = new Date('2026-07-29T15:00:00.000Z');

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
    clock: () => NOW,
    newId: randomUUID,
  };
  processWager = new ProcessWagerTransaction(dependencies);
  openWallet = new OpenWallet(dependencies);
});

afterAll(async () => {
  await database.drop();
});

function consumerWith(
  options: { faults?: ConsumerFaults; process?: Pick<ProcessWagerTransaction, 'execute'> } = {},
) {
  return new WagerCommandConsumer({
    consumerName: 'wager-transactions',
    queue: new SqsQueue(sqs, queues.commandQueueUrl),
    deadLetters: new SqsQueue(sqs, queues.deadLetterQueueUrl),
    process: options.process ?? processWager,
    visibilityTimeoutSeconds: 1,
    faults: options.faults ?? NO_FAULTS,
  });
}

async function fundedWallet(): Promise<{ walletId: string; playerId: string }> {
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  return { walletId, playerId };
}

function requestedMessage(
  wallet: { walletId: string; playerId: string },
  overrides: { messageId?: string; amount?: string; externalTransactionId?: string } = {},
): string {
  const externalTransactionId = overrides.externalTransactionId ?? `transaction-${randomUUID()}`;
  return JSON.stringify({
    messageId: overrides.messageId ?? `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: NOW.toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: overrides.amount ?? '25.00', currency: 'BRL' },
    },
  });
}

async function send(body: string): Promise<void> {
  await new SqsQueue(sqs, queues.commandQueueUrl).send(body, 'group', randomUUID());
}

async function debitsOf(walletId: string): Promise<number> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(
      `SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
      [walletId],
    )) as Array<{ n: string }>;
  return Number(rows[0]?.n ?? 0);
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT balance::text AS b FROM wallets WHERE id = ?`, [walletId])) as Array<{
    b: string;
  }>;
  return rows[0]?.b ?? '';
}

/**
 * Receives and deletes what it finds, so a message is never left in flight. An in-flight
 * message would block its FIFO group and hide later messages from the next test.
 */
async function drain(queueUrl: string): Promise<number> {
  const queue = new SqsQueue(sqs, queueUrl);
  // Long poll: short polling samples a subset of SQS servers and can miss messages.
  const messages = await queue.receive({
    maxMessages: 10,
    waitSeconds: 1,
    visibilityTimeoutSeconds: 30,
  });
  for (const message of messages) {
    await queue.acknowledge(message.receiptHandle);
  }
  return messages.length;
}

describe('WagerCommandConsumer', () => {
  test('a valid command is applied, its events are committed, and the message is acknowledged', async () => {
    const wallet = await fundedWallet();
    await send(requestedMessage(wallet));

    const handled = await consumerWith().pollOnce();

    expect(handled).toBe(1);
    expect(await balanceOf(wallet.walletId)).toBe('75.00');
    expect(await debitsOf(wallet.walletId)).toBe(1);
    expect(await drain(queues.commandQueueUrl)).toBe(0);
  });

  test('a redelivered message with the same messageId does not apply its effect twice', async () => {
    const wallet = await fundedWallet();
    const body = requestedMessage(wallet);
    await send(body);
    await send(body);

    await consumerWith().pollOnce();
    await consumerWith().pollOnce();

    expect(await balanceOf(wallet.walletId)).toBe('75.00');
    expect(await debitsOf(wallet.walletId)).toBe(1);
  });

  test('a crash after commit and before the acknowledgement is recovered by redelivery, without a second effect', async () => {
    const wallet = await fundedWallet();
    await send(requestedMessage(wallet));
    const crashing: ConsumerFaults = {
      beforeAcknowledge: async () => {
        throw new Error('simulated process crash after commit');
      },
    };

    await expect(consumerWith({ faults: crashing }).pollOnce()).rejects.toThrow(
      'simulated process crash',
    );
    expect(await debitsOf(wallet.walletId)).toBe(1);

    let redelivered = 0;
    for (let attempt = 0; attempt < 10 && redelivered === 0; attempt += 1) {
      redelivered = await consumerWith().pollOnce();
    }

    expect(redelivered).toBe(1);
    expect(await balanceOf(wallet.walletId)).toBe('75.00');
    expect(await debitsOf(wallet.walletId)).toBe(1);
    expect(await drain(queues.commandQueueUrl)).toBe(0);
  });

  test('a malformed message is dead-lettered and removed from the command queue', async () => {
    await send('this is not json');

    await consumerWith().pollOnce();

    expect(await drain(queues.commandQueueUrl)).toBe(0);
    expect(await drain(queues.deadLetterQueueUrl)).toBe(1);
  });

  test('a reused messageId with a different payload is dead-lettered as permanently invalid', async () => {
    const wallet = await fundedWallet();
    const messageId = `msg-${randomUUID()}`;
    await send(requestedMessage(wallet, { messageId, amount: '25.00' }));
    await send(requestedMessage(wallet, { messageId, amount: '30.00' }));

    await consumerWith().pollOnce();
    await consumerWith().pollOnce();

    expect(await balanceOf(wallet.walletId)).toBe('75.00');
    expect(await drain(queues.deadLetterQueueUrl)).toBe(1);
  });

  test('a transient failure leaves the message in the queue with backed-off visibility', async () => {
    const wallet = await fundedWallet();
    await send(requestedMessage(wallet));
    const failing = {
      execute: async () => {
        throw new ConcurrencyConflictError('simulated lost race');
      },
    };

    await consumerWith({ process: failing }).pollOnce();

    const queue = new SqsQueue(sqs, queues.commandQueueUrl);
    expect(await queue.countInFlight()).toBe(1);
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
  });
});
