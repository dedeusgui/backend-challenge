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
import { WagerCommandConsumer } from '../../../src/modules/messaging/application/inbound/wager-command-consumer';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, testSqsClient, type TestQueues } from '../support/sqs-test-queues';
import { required } from '../../support/required';

/**
 * A message is in flight for as long as its command is being processed. A slow command that outlasts the
 * visibility window must keep its message invisible, or another consumer takes it and the broker counts one
 * more delivery. The hold has a limit: a processor that hangs past it releases the message, so the message is
 * never held forever. The effect is still applied once, because the transaction identity is the same.
 */

const VISIBILITY_SECONDS = 2;
const STALL_MS = 6_000;

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
}, 60_000);

afterAll(async () => {
  await database.drop();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A BET of 1.00 on a wallet of 100.00, sent as the wager-command message the consumer parses. */
async function wagerMessage(messageId: string): Promise<{ body: string; walletId: string }> {
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  const externalTransactionId = `tx-${randomUUID()}`;
  const body = JSON.stringify({
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
  });
  return { body, walletId };
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await database.orm.em
    .getConnection()
    .execute('SELECT balance::text AS balance FROM wallets WHERE id = ?', [walletId])) as Array<{
    balance: string;
  }>;
  return required(rows[0], 'the wallet').balance;
}

/** Counts every hand-off to the use case, and holds each one for `stallMs` before it runs. */
function stalling(stallMs: number, executions: Map<string, number>) {
  return {
    execute: async (command: ProcessWagerCommand): Promise<ProcessWagerOutcome> => {
      const id = command.inbound?.messageId ?? '';
      executions.set(id, (executions.get(id) ?? 0) + 1);
      if (stallMs > 0) {
        await sleep(stallMs);
      }
      return processWager.execute(command);
    },
  };
}

function consumer(
  process: { execute(command: ProcessWagerCommand): Promise<ProcessWagerOutcome> },
  holdLimitSeconds?: number,
): WagerCommandConsumer {
  return new WagerCommandConsumer({
    consumerName: 'wager-transactions',
    queue: new SqsQueue(sqs, queues.commandQueueUrl),
    deadLetters: new SqsQueue(sqs, queues.deadLetterQueueUrl),
    process,
    visibilityTimeoutSeconds: VISIBILITY_SECONDS,
    holdLimitSeconds,
  });
}

describe('a message is held while its slow command is processed', () => {
  test('a command that outlasts the visibility window keeps its message from a second consumer', async () => {
    const messageId = `msg-${randomUUID()}`;
    const { body, walletId } = await wagerMessage(messageId);
    await new SqsQueue(sqs, queues.commandQueueUrl).send(body, walletId, randomUUID());

    const executions = new Map<string, number>();
    const first = consumer(stalling(STALL_MS, executions));
    const second = consumer(stalling(0, executions));

    const firstPass = first.pollOnce();
    await sleep(3_500);
    const secondPass = await second.pollOnce();
    const firstRemoved = await firstPass;

    expect(secondPass).toBe(0);
    expect(executions.get(messageId)).toBe(1);
    expect(firstRemoved).toBe(1);
    expect(await balanceOf(walletId)).toBe('99.00');
  }, 30_000);

  test('a processor that holds past the hold limit releases the message, and the effect still applies once', async () => {
    const messageId = `msg-${randomUUID()}`;
    const { body, walletId } = await wagerMessage(messageId);
    await new SqsQueue(sqs, queues.commandQueueUrl).send(body, walletId, randomUUID());

    const executions = new Map<string, number>();
    const HOLD_LIMIT_SECONDS = 3;
    const first = consumer(stalling(8_000, executions), HOLD_LIMIT_SECONDS);
    const second = consumer(stalling(0, executions));

    const firstPass = first.pollOnce();
    // Within the hold limit the message is still held.
    await sleep(2_500);
    const within = await second.pollOnce();
    // Past the hold limit, with the last renewal's window ended, the message is delivered again.
    await sleep(2_000);
    const after = await second.pollOnce();
    await firstPass;

    expect(within).toBe(0);
    expect(after).toBe(1);
    expect(executions.get(messageId)).toBe(2);
    expect(await balanceOf(walletId)).toBe('99.00');
  }, 30_000);
});
