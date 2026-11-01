import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerCommandConsumer } from '../../../src/modules/messaging/application/inbound/wager-command-consumer';
import type { OperationLog } from '../../../src/shared/observability/structured-log';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, testSqsClient, type TestQueues } from '../support/sqs-test-queues';
import { required } from '../../support/required';

/**
 * One command reaches the service twice: once over HTTP, and once as a queue message with the same key and the
 * same payload. The second arrival is a replay of the first, in either order, and the wallet moves once.
 */

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

/** The HTTP path calls the use case with no inbound message. */
async function bet(): Promise<{ command: ProcessWagerCommand; walletId: string }> {
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  const externalTransactionId = `tx-${randomUUID()}`;
  return {
    walletId,
    command: {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: Money.from({ amount: '1.00', currency: 'BRL' }),
      referenceExternalTransactionId: undefined,
      correlationId: 'corr',
    },
  };
}

/** The same command as a queue message: the same key and the same business fields, with a message id. */
function asMessage(command: ProcessWagerCommand): string {
  return JSON.stringify({
    messageId: `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money.toJSON(),
    },
  });
}

function consumerWith(logs: OperationLog[]): WagerCommandConsumer {
  return new WagerCommandConsumer({
    consumerName: 'wager-transactions',
    queue: new SqsQueue(sqs, queues.commandQueueUrl),
    deadLetters: new SqsQueue(sqs, queues.deadLetterQueueUrl),
    process: processWager,
    visibilityTimeoutSeconds: 30,
    logger: (entry) => logs.push(entry),
  });
}

async function transactionCount(externalTransactionId: string): Promise<number> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(
      `SELECT count(*)::text AS n FROM wager_transactions WHERE provider_id = 'provider-a' AND external_transaction_id = ?`,
      [externalTransactionId],
    )) as Array<{ n: string }>;
  return Number(required(rows[0], 'a count').n);
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT balance::text AS b FROM wallets WHERE id = ?`, [walletId])) as Array<{
    b: string;
  }>;
  return required(rows[0]?.b, 'a balance row');
}

describe('the same command over HTTP and over the queue', () => {
  test('a command submitted over HTTP, then delivered by the queue, is applied once and the queue copy is a replay', async () => {
    const { command, walletId } = await bet();
    const http = await processWager.execute(command);
    await new SqsQueue(sqs, queues.commandQueueUrl).send(
      asMessage(command),
      walletId,
      randomUUID(),
    );

    const logs: OperationLog[] = [];
    expect(await consumerWith(logs).pollOnce()).toBe(1);

    expect(http.idempotentReplay).toBe(false);
    expect(logs.find((entry) => entry.operation === 'command.settle')?.status).toBe('APPLIED');
    expect(await transactionCount(command.externalTransactionId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('99.00');
  });

  test('a command delivered by the queue, then submitted over HTTP, is answered as a replay and moves the wallet once', async () => {
    const { command, walletId } = await bet();
    await new SqsQueue(sqs, queues.commandQueueUrl).send(
      asMessage(command),
      walletId,
      randomUUID(),
    );
    const logs: OperationLog[] = [];
    expect(await consumerWith(logs).pollOnce()).toBe(1);

    const http = await processWager.execute(command);

    expect(logs.find((entry) => entry.operation === 'command.settle')?.status).toBe('APPLIED');
    expect(http.idempotentReplay).toBe(true);
    expect(await transactionCount(command.externalTransactionId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('99.00');
  });
});
