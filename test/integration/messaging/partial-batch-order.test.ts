import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransaction } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { OutboxPublisher } from '../../../src/modules/messaging/application/outbox-publisher';
import { MikroOrmOutboxStore } from '../../../src/modules/messaging/infrastructure/mikro-orm-outbox.store';
import {
  SqsEventTransport,
  type EventBatchEntry,
  type EventBatchOutcome,
  type EventBatchSender,
} from '../../../src/modules/messaging/infrastructure/sqs/sqs-event-transport';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { advanceOutboxClock } from '../support/outbox-clock';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, testSqsClient, type TestQueues } from '../support/sqs-test-queues';
import { required } from '../../support/required';

/**
 * One wallet, three committed events: E1 (the opening, version 1), E2 (a BET, version 2) and E3 (a BET,
 * version 3). The broker refuses E2 alone in the first request, as SendMessageBatch does for one entry,
 * and accepts E1 and E3. The test reads the outbox after each pass and the events queue at the end, so
 * the order it asserts is the order a consumer of the real queue receives.
 */

const NOW = new Date('2026-07-29T15:00:00.000Z');
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

let database: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  database = await createTestDatabase();
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
}, 60_000);

afterAll(async () => {
  await database.drop();
});

/** The real queue adapter, with one entry refused by the broker on its first request. Otherwise a pass-through. */
class RefuseEntryOnce implements EventBatchSender {
  private refusals = 0;

  constructor(
    private readonly inner: EventBatchSender,
    private readonly target: () => string,
  ) {}

  get refused(): number {
    return this.refusals;
  }

  async sendBatch(entries: readonly EventBatchEntry[]): Promise<EventBatchOutcome> {
    const targetId = this.target();
    if (this.refusals > 0 || !entries.some((entry) => entry.id === targetId)) {
      return this.inner.sendBatch(entries);
    }
    this.refusals += 1;
    const forwarded = entries.filter((entry) => entry.id !== targetId);
    const outcome = await this.inner.sendBatch(forwarded);
    return {
      sentIds: outcome.sentIds,
      refused: [
        ...outcome.refused,
        { id: targetId, code: 'InternalError', message: 'simulated refusal of one entry' },
      ],
    };
  }
}

function publisherFor(sender: EventBatchSender, clock: () => Date) {
  return new OutboxPublisher({
    store: new MikroOrmOutboxStore(database.orm),
    transport: new SqsEventTransport(sender),
    clock,
    newLeaseToken: randomUUID,
    leaseDurationMs: 30_000,
    batchSize: 10,
  });
}

interface OutboxRow {
  id: string;
  wallet_version: number;
  published: boolean;
  attempts: number;
  due_in_future: boolean;
}

/** The outbox rows of one wallet's balance events, in version order, with their state. */
async function walletEventRows(walletId: string): Promise<OutboxRow[]> {
  const rows = (await database.orm.em.getConnection().execute(
    `SELECT id::text AS id,
            (payload->'data'->>'walletVersion')::int AS wallet_version,
            published_at IS NOT NULL AS published,
            attempts,
            next_attempt_at > now() AS due_in_future
       FROM outbox_messages
      WHERE aggregate_id = ? AND event_type = 'WalletBalanceChanged'
      ORDER BY (payload->'data'->>'walletVersion')::int`,
    [walletId],
  )) as OutboxRow[];
  return rows;
}

/** Reads every message the events queue holds for one wallet, acknowledging each, in the order received. */
async function drainWalletVersions(walletId: string): Promise<number[]> {
  const events = new SqsQueue(sqs, queues.eventsQueueUrl);
  const versions: number[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const received = await events.receive({
      maxMessages: 10,
      waitSeconds: 1,
      visibilityTimeoutSeconds: 30,
    });
    if (received.length === 0) {
      break;
    }
    for (const message of received) {
      const parsed = JSON.parse(message.body) as {
        aggregateId?: unknown;
        eventType?: unknown;
        data?: { walletVersion?: unknown };
      };
      if (
        parsed.aggregateId === walletId &&
        parsed.eventType === 'WalletBalanceChanged' &&
        typeof parsed.data?.walletVersion === 'number'
      ) {
        versions.push(parsed.data.walletVersion);
      }
      await events.acknowledge(message.receiptHandle);
    }
  }
  return versions;
}

describe('a refused event in a batch, within one wallet', () => {
  test('the broker sees E1 and E3 before E2, the outbox holds E2 alone until its retry, and the retry completes the sequence', async () => {
    // Earlier tests in this file leave nothing pending, but drain anyway, so the batch holds only this test.
    const drainAll = publisherFor(
      new RefuseEntryOnce(new SqsQueue(sqs, queues.eventsQueueUrl), () => ''),
      () => new Date(),
    );
    while ((await drainAll.publishOnce()) > 0) {
      // Each pass publishes what is due. The loop ends when nothing is due.
    }

    // Each commit gets its own instant, in order, so the claim orders the three events by commit.
    let tick = 0;
    const commitAt = () => new Date(NOW.getTime() + (tick += 1));
    const unitOfWork = new MikroOrmFinancialUnitOfWork(database.orm);
    const playerId = `player-${randomUUID()}`;
    const { walletId } = await new OpenWallet({
      unitOfWork,
      clock: commitAt,
      newId: randomUUID,
    }).execute({ playerId, initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }) });
    const wagers = new ProcessWagerTransaction({ unitOfWork, clock: commitAt, newId: randomUUID });
    for (let bet = 0; bet < 2; bet += 1) {
      await wagers.execute({
        idempotencyKey: `k-${randomUUID()}`,
        providerId: 'provider-a',
        externalTransactionId: `t-${randomUUID()}`,
        playerId,
        walletId,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: Money.from({ amount: '1.00', currency: 'BRL' }),
        referenceExternalTransactionId: undefined,
        correlationId: 'corr',
      });
    }

    const before = await walletEventRows(walletId);
    expect(before.map((row) => row.wallet_version)).toEqual([1, 2, 3]);
    expect(before.every((row) => !row.published)).toBe(true);
    const e2 = required(before[1], 'the second event of the wallet');

    // Pass 1. E2 is refused by the broker, so its retry is scheduled from now; E1 and E3 are accepted.
    const sender = new RefuseEntryOnce(new SqsQueue(sqs, queues.eventsQueueUrl), () => e2.id);
    // The pass also sends the transaction events of the two BETs, which belong to other aggregates.
    await publisherFor(sender, () => new Date()).publishOnce();
    const afterFirst = await walletEventRows(walletId);

    expect(sender.refused).toBe(1);
    expect(afterFirst.map((row) => [row.wallet_version, row.published])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
    expect(afterFirst[1]).toMatchObject({ attempts: 1, due_in_future: true });
    expect(await drainWalletVersions(walletId)).toEqual([1, 3]);

    // E2 is not claimed before its backoff ends. The drain above takes real time, longer than the one-second
    // backoff, so the database clock is held back an hour first: the backoff has not ended, and a pass publishes nothing.
    await advanceOutboxClock(database, -ONE_HOUR);
    const early = await publisherFor(sender, () => new Date()).publishOnce();
    expect(early).toBe(0);

    // Pass 2, a day later on the database clock. The retry sends E2, which the broker accepts.
    await advanceOutboxClock(database, ONE_DAY);
    const secondPass = await publisherFor(sender, () => new Date()).publishOnce();
    const afterSecond = await walletEventRows(walletId);

    expect(secondPass).toBe(1);
    expect(afterSecond.every((row) => row.published)).toBe(true);
    expect(afterSecond.map((row) => row.attempts)).toEqual([0, 1, 0]);
    expect(await drainWalletVersions(walletId)).toEqual([2]);
  });
});
