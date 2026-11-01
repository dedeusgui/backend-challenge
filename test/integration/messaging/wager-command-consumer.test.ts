import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { ConcurrencyConflictError } from '../../../src/shared/application/application-errors';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransaction } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerCommandConsumer } from '../../../src/modules/messaging/application/wager-command-consumer';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import type { MessageQueue } from '../../../src/modules/messaging/application/message-queue.port';
import { MetricsRegistry } from '../../../src/shared/observability/metrics';
import type { OperationLog } from '../../../src/shared/observability/structured-log';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, testSqsClient, type TestQueues } from '../support/sqs-test-queues';
import { required } from '../../support/required';

const NOW = new Date('2026-07-29T15:00:00.000Z');

let database: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;
let processWager: ProcessWagerTransaction;
const metrics = new MetricsRegistry();
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
  options: {
    process?: Pick<ProcessWagerTransaction, 'execute'>;
    logger?: (entry: OperationLog) => void;
    queue?: MessageQueue;
    deadLetters?: MessageQueue;
  } = {},
) {
  return new WagerCommandConsumer({
    consumerName: 'wager-transactions',
    queue: options.queue ?? new SqsQueue(sqs, queues.commandQueueUrl),
    deadLetters: options.deadLetters ?? new SqsQueue(sqs, queues.deadLetterQueueUrl),
    process: options.process ?? processWager,
    visibilityTimeoutSeconds: 1,
    metrics,
    logger: options.logger,
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

/** Messages share one FIFO group by default. A test that must not wait behind an in-flight message uses its own group. */
async function send(body: string, group = 'group'): Promise<void> {
  await new SqsQueue(sqs, queues.commandQueueUrl).send(body, group, randomUUID());
}

async function transactionsFor(externalTransactionId: string): Promise<number> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(
      `SELECT count(*)::text AS n FROM wager_transactions WHERE external_transaction_id = ?`,
      [externalTransactionId],
    )) as Array<{ n: string }>;
  return Number(rows[0]?.n ?? '0');
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
  return required(rows[0]?.b, 'a balance row');
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
    // The process dies after the commit and before the acknowledgement: the first acknowledge never reaches the broker.
    let crashed = false;
    const commands = new SqsQueue(sqs, queues.commandQueueUrl);
    const crashingBeforeAcknowledge: MessageQueue = {
      send: (body, group, deduplicationId) => commands.send(body, group, deduplicationId),
      receive: (options) => commands.receive(options),
      changeVisibility: (receiptHandle, seconds) =>
        commands.changeVisibility(receiptHandle, seconds),
      extendVisibility: (receiptHandles, seconds) =>
        commands.extendVisibility(receiptHandles, seconds),
      acknowledge: async (receiptHandle) => {
        if (!crashed) {
          crashed = true;
          throw new Error('simulated process crash after commit');
        }
        await commands.acknowledge(receiptHandle);
      },
    };

    await expect(consumerWith({ queue: crashingBeforeAcknowledge }).pollOnce()).rejects.toThrow(
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

  test('a crash after the dead-letter send and before the acknowledgement is recovered: dead-lettered again, no effect', async () => {
    const unknown = { walletId: randomUUID(), playerId: `player-${randomUUID()}` };
    const externalTransactionId = `transaction-${randomUUID()}`;
    await send(requestedMessage(unknown, { externalTransactionId }));
    const commands = new SqsQueue(sqs, queues.commandQueueUrl);
    let crashed = false;
    const crashingAcknowledge: MessageQueue = {
      send: (body, group, deduplicationId) => commands.send(body, group, deduplicationId),
      receive: (options) => commands.receive(options),
      changeVisibility: (receiptHandle, seconds) =>
        commands.changeVisibility(receiptHandle, seconds),
      extendVisibility: (receiptHandles, seconds) =>
        commands.extendVisibility(receiptHandles, seconds),
      acknowledge: async (receiptHandle) => {
        if (!crashed) {
          crashed = true;
          throw new Error('simulated process crash after the dead-letter send');
        }
        await commands.acknowledge(receiptHandle);
      },
    };

    await expect(consumerWith({ queue: crashingAcknowledge }).pollOnce()).rejects.toThrow(
      'simulated process crash',
    );

    let redelivered = 0;
    for (let attempt = 0; attempt < 10 && redelivered === 0; attempt += 1) {
      redelivered = await consumerWith({ queue: crashingAcknowledge }).pollOnce();
    }

    expect(redelivered).toBe(1);
    expect(await drain(queues.commandQueueUrl)).toBe(0);
    // The copy's deduplication id is derived from its body, so the send repeated on redelivery is accepted
    // once inside the broker's five-minute window: one copy in the dead-letter queue, never zero.
    expect(await drain(queues.deadLetterQueueUrl)).toBe(1);
    expect(await transactionsFor(externalTransactionId)).toBe(0);
  });

  test('a dead-letter send that the broker refuses is retried on redelivery, so the message is not lost', async () => {
    const unknown = { walletId: randomUUID(), playerId: `player-${randomUUID()}` };
    await send(requestedMessage(unknown));
    const deadLetters = new SqsQueue(sqs, queues.deadLetterQueueUrl);
    let refused = false;
    const flakyDeadLetters: MessageQueue = {
      send: async (body, group, deduplicationId) => {
        if (!refused) {
          refused = true;
          throw new Error('simulated broker refusal');
        }
        await deadLetters.send(body, group, deduplicationId);
      },
      receive: (options) => deadLetters.receive(options),
      changeVisibility: (receiptHandle, seconds) =>
        deadLetters.changeVisibility(receiptHandle, seconds),
      extendVisibility: (receiptHandles, seconds) =>
        deadLetters.extendVisibility(receiptHandles, seconds),
      acknowledge: (receiptHandle) => deadLetters.acknowledge(receiptHandle),
    };

    await expect(consumerWith({ deadLetters: flakyDeadLetters }).pollOnce()).rejects.toThrow(
      'simulated broker refusal',
    );
    let removed = 0;
    for (let attempt = 0; attempt < 10 && removed === 0; attempt += 1) {
      removed = await consumerWith({ deadLetters: flakyDeadLetters }).pollOnce();
    }

    expect(removed).toBe(1);
    expect(await drain(queues.commandQueueUrl)).toBe(0);
    expect(await drain(queues.deadLetterQueueUrl)).toBe(1);
  });

  test('a malformed message is dead-lettered and removed from the command queue', async () => {
    await send('this is not json');

    await consumerWith().pollOnce();

    expect(await drain(queues.commandQueueUrl)).toBe(0);
    expect(await drain(queues.deadLetterQueueUrl)).toBe(1);
  });

  test('an amount without exactly two decimals is dead-lettered as permanently invalid, and moves nothing', async () => {
    const wallet = await fundedWallet();
    await send(requestedMessage(wallet, { amount: '25' }));

    await consumerWith().pollOnce();

    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    expect(await debitsOf(wallet.walletId)).toBe(0);
    expect(await drain(queues.deadLetterQueueUrl)).toBe(1);
  });

  test('a wallet id that is not a UUID is dead-lettered at once, as HTTP refuses it, and reaches no transaction', async () => {
    const body = JSON.stringify({
      messageId: `msg-${randomUUID()}`,
      type: 'WagerTransactionRequested',
      occurredAt: NOW.toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: `transaction-${randomUUID()}`,
        idempotencyKey: `provider-a:transaction-${randomUUID()}`,
        playerId: `player-${randomUUID()}`,
        walletId: 'not-a-uuid',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    });
    // Its own FIFO group: a message that stays in flight here must not block the shared group.
    await send(body, `uuid-${randomUUID()}`);

    const removed = await consumerWith().pollOnce();

    expect(removed).toBe(1);
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

  test('a failed command is logged with its error class and code, and never with its amount', async () => {
    const wallet = await fundedWallet();
    // The transient test above leaves its message in flight in the default group, which would block this one.
    await send(requestedMessage(wallet), `log-${randomUUID()}`);
    const logged: OperationLog[] = [];
    const failing = {
      execute: async () => {
        throw new ConcurrencyConflictError('lost a race for 25.00 BRL');
      },
    };

    await consumerWith({ process: failing, logger: (entry) => logged.push(entry) }).pollOnce();

    expect(logged).toContainEqual(
      expect.objectContaining({
        operation: 'command.settle',
        status: 'RETRY',
        errorName: 'ConcurrencyConflictError',
        errorCode: 'CONCURRENCY_CONFLICT',
      }),
    );
    expect(JSON.stringify(logged)).not.toContain('25.00');
  });

  test('the consumer counts each disposition it produced', () => {
    const counters = metrics.snapshot().counters;

    expect(counters['commands_total{result="APPLIED"}']).toBeGreaterThanOrEqual(1);
    expect(counters['commands_total{result="DEAD"}']).toBeGreaterThanOrEqual(1);
    expect(counters['commands_total{result="RETRY"}']).toBeGreaterThanOrEqual(1);
  });
});
