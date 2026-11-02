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
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { MetricsRegistry } from '../../../src/shared/observability/metrics';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import {
  closeTestSqs,
  createTestQueues,
  testSqsClient,
  type TestQueues,
} from '../support/sqs-test-queues';
import { required } from '../../support/required';

/**
 * At-least-once delivery means one operation can arrive many times: the same message redelivered, the
 * producer resending it under a new message id, or the same operation arriving over HTTP and the queue.
 * Each test below counts what the database holds afterwards, and expects one effect per operation.
 */

const NOW = new Date('2026-07-29T15:00:00.000Z');
const SETTLE_TIMEOUT_MS = 60_000;

let database: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;
let processWager: ProcessWagerTransaction;
let openWallet: OpenWallet;
const metrics = new MetricsRegistry();

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
  try {
    await database?.drop();
  } finally {
    await closeTestSqs(sqs, queues);
  }
});

interface Wallet {
  walletId: string;
  playerId: string;
}

async function fundedWallet(amount: string): Promise<Wallet> {
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount, currency: 'BRL' }),
  });
  return { walletId, playerId };
}

interface Operation {
  externalTransactionId: string;
  idempotencyKey: string;
  kind: 'BET' | 'WIN' | 'REFUND';
  amount: string;
  referenceExternalTransactionId?: string;
}

function operation(overrides: Partial<Operation> & Pick<Operation, 'kind' | 'amount'>): Operation {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${randomUUID()}`;
  return {
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    ...overrides,
  };
}

/** A queue message for one operation. The producer picks the message id, so a resend can change it. */
function messageFor(wallet: Wallet, op: Operation, messageId = `msg-${randomUUID()}`): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: NOW.toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: op.externalTransactionId,
      idempotencyKey: op.idempotencyKey,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: op.kind,
      money: { amount: op.amount, currency: 'BRL' },
      ...(op.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: op.referenceExternalTransactionId }),
    },
  });
}

/** Each message gets its own group, so the broker may hand them to consumers at the same time. */
async function sendConcurrently(bodies: string[]): Promise<void> {
  const commands = new SqsQueue(sqs, queues.commandQueueUrl);
  for (const body of bodies) {
    await commands.send(body, `group-${randomUUID()}`, randomUUID());
  }
}

function consumer(): WagerCommandConsumer {
  return new WagerCommandConsumer({
    consumerName: 'wager-transactions',
    queue: new SqsQueue(sqs, queues.commandQueueUrl),
    deadLetters: new SqsQueue(sqs, queues.deadLetterQueueUrl),
    process: processWager,
    visibilityTimeoutSeconds: 1,
    metrics,
  });
}

/** Runs several consumers at once until every message has been applied, replayed or dead-lettered. */
async function settle(expected: number, consumers = 3): Promise<number> {
  const workers = Array.from({ length: consumers }, () => consumer());
  let settled = 0;
  for (let round = 0; round < 40 && settled < expected; round += 1) {
    const counts = await Promise.all(workers.map((worker) => worker.pollOnce()));
    settled += counts.reduce((sum, handled) => sum + handled, 0);
  }
  return settled;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const rows = (await database.orm.em.getConnection().execute(sql, params)) as Array<{ n: string }>;
  return Number(rows[0]?.n ?? 0);
}

/** Ledger entries of one direction in one wallet: each one is one effect on the balance. */
function ledgerEntries(walletId: string, direction: 'DEBIT' | 'CREDIT'): Promise<number> {
  return count(
    `SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = ?`,
    [walletId, direction],
  );
}

function transactionsFor(walletId: string, externalTransactionId: string): Promise<number> {
  return count(
    `SELECT count(*)::text AS n FROM wager_transactions WHERE wallet_id = ? AND external_transaction_id = ?`,
    [walletId, externalTransactionId],
  );
}

function balanceEventsOf(walletId: string): Promise<number> {
  return count(
    `SELECT count(*)::text AS n FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WalletBalanceChanged'`,
    [walletId],
  );
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT balance::text AS b FROM wallets WHERE id = ?`, [walletId])) as Array<{
    b: string;
  }>;
  return required(rows[0]?.b, 'a balance row');
}

function drainDeadLetters(): Promise<number> {
  return drainQueue(queues.deadLetterQueueUrl);
}

/** Reads and acknowledges everything in a queue, and returns how many messages it held. */
async function drainQueue(queueUrl: string): Promise<number> {
  const messages = await new SqsQueue(sqs, queueUrl).receive({
    maxMessages: 10,
    waitSeconds: 1,
    visibilityTimeoutSeconds: 30,
  });
  for (const message of messages) {
    await new SqsQueue(sqs, queueUrl).acknowledge(message.receiptHandle);
  }
  return messages.length;
}

describe('one operation delivered many times is applied once', () => {
  test(
    'the same message delivered twenty times, to three consumers at once, debits once',
    async () => {
      const wallet = await fundedWallet('100.00');
      const bet = operation({ kind: 'BET', amount: '25.00' });
      const body = messageFor(wallet, bet, 'msg-the-same');
      const eventsBefore = await balanceEventsOf(wallet.walletId);
      await sendConcurrently(Array.from({ length: 20 }, () => body));

      const settled = await settle(20);
      expect(await balanceOf(wallet.walletId)).toBe('75.00');
      expect(await ledgerEntries(wallet.walletId, 'DEBIT')).toBe(1);
      expect(await transactionsFor(wallet.walletId, bet.externalTransactionId)).toBe(1);
      expect(await balanceEventsOf(wallet.walletId)).toBe(eventsBefore + 1);
      expect(await drainDeadLetters()).toBe(0);
      expect(settled).toBe(20);
    },
    SETTLE_TIMEOUT_MS,
  );

  test(
    'the producer resends one operation five times under new message ids, and it debits once',
    async () => {
      const wallet = await fundedWallet('100.00');
      const bet = operation({ kind: 'BET', amount: '25.00' });
      const eventsBefore = await balanceEventsOf(wallet.walletId);
      await sendConcurrently(Array.from({ length: 5 }, () => messageFor(wallet, bet)));

      const settled = await settle(5);
      expect(await balanceOf(wallet.walletId)).toBe('75.00');
      expect(await ledgerEntries(wallet.walletId, 'DEBIT')).toBe(1);
      expect(await transactionsFor(wallet.walletId, bet.externalTransactionId)).toBe(1);
      expect(await balanceEventsOf(wallet.walletId)).toBe(eventsBefore + 1);
      expect(await drainDeadLetters()).toBe(0);
      expect(settled).toBe(5);
    },
    SETTLE_TIMEOUT_MS,
  );

  test(
    'the same operation over HTTP and in the queue debits once',
    async () => {
      const wallet = await fundedWallet('100.00');
      const bet = operation({ kind: 'BET', amount: '25.00' });
      const command: ProcessWagerCommand = {
        idempotencyKey: bet.idempotencyKey,
        providerId: 'provider-a',
        externalTransactionId: bet.externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        referenceExternalTransactionId: undefined,
        correlationId: `corr-${randomUUID()}`,
      };
      await processWager.execute(command);
      await sendConcurrently([messageFor(wallet, bet), messageFor(wallet, bet)]);

      const settled = await settle(2);
      expect(await balanceOf(wallet.walletId)).toBe('75.00');
      expect(await ledgerEntries(wallet.walletId, 'DEBIT')).toBe(1);
      expect(await transactionsFor(wallet.walletId, bet.externalTransactionId)).toBe(1);
      expect(settled).toBe(2);
    },
    SETTLE_TIMEOUT_MS,
  );

  test(
    'the same external transaction resent under another idempotency key is a replay, not a second debit',
    async () => {
      const wallet = await fundedWallet('100.00');
      const bet = operation({ kind: 'BET', amount: '25.00' });
      const rekeyed = { ...bet, idempotencyKey: `provider-a:another-${randomUUID()}` };
      await sendConcurrently([messageFor(wallet, bet), messageFor(wallet, rekeyed)]);

      const settled = await settle(2);
      expect(await balanceOf(wallet.walletId)).toBe('75.00');
      expect(await ledgerEntries(wallet.walletId, 'DEBIT')).toBe(1);
      expect(await transactionsFor(wallet.walletId, bet.externalTransactionId)).toBe(1);
      expect(settled).toBe(2);
    },
    SETTLE_TIMEOUT_MS,
  );

  test(
    'a resend of the same key with a different amount is a conflict: it is dead-lettered and applies nothing',
    async () => {
      const wallet = await fundedWallet('100.00');
      const bet = operation({ kind: 'BET', amount: '25.00' });
      const changed = { ...bet, amount: '30.00' };
      await sendConcurrently([
        messageFor(wallet, bet),
        messageFor(wallet, bet),
        messageFor(wallet, changed),
      ]);

      const settled = await settle(3);
      expect(await balanceOf(wallet.walletId)).toBe('75.00');
      expect(await ledgerEntries(wallet.walletId, 'DEBIT')).toBe(1);
      expect(await drainDeadLetters()).toBe(1);
      expect(settled).toBe(3);
    },
    SETTLE_TIMEOUT_MS,
  );

  test(
    'a refund delivered five times reverses its bet once, and the stake returns once',
    async () => {
      const wallet = await fundedWallet('100.00');
      const bet = operation({ kind: 'BET', amount: '25.00' });
      await sendConcurrently([messageFor(wallet, bet)]);
      await settle(1);
      const refund = operation({
        kind: 'REFUND',
        amount: '25.00',
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      await sendConcurrently(Array.from({ length: 5 }, () => messageFor(wallet, refund)));

      const settled = await settle(5);
      expect(await balanceOf(wallet.walletId)).toBe('100.00');
      expect(await ledgerEntries(wallet.walletId, 'CREDIT')).toBe(2);
      expect(await transactionsFor(wallet.walletId, refund.externalTransactionId)).toBe(1);
      expect(settled).toBe(5);
    },
    SETTLE_TIMEOUT_MS,
  );
});

describe('the boundary of deduplication', () => {
  test(
    'two operations with different external ids are two operations, even when their payloads match',
    async () => {
      const wallet = await fundedWallet('100.00');
      const bet = operation({ kind: 'BET', amount: '25.00' });
      await sendConcurrently([messageFor(wallet, bet)]);
      await settle(1);
      const firstWin = operation({ kind: 'WIN', amount: '40.00' });
      const secondWin = operation({ kind: 'WIN', amount: '40.00' });
      await sendConcurrently([messageFor(wallet, firstWin), messageFor(wallet, secondWin)]);

      await settle(2);

      // A provider that resends a win under a new external id is not a duplicate to this service:
      // the identity of an operation is its external transaction id, as the specification defines it.
      expect(await balanceOf(wallet.walletId)).toBe('155.00');
      expect(await ledgerEntries(wallet.walletId, 'CREDIT')).toBe(3);
    },
    SETTLE_TIMEOUT_MS,
  );
});
