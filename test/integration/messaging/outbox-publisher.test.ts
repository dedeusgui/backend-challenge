import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransaction } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import {
  OutboxPublisher,
  type OutboxTransport,
} from '../../../src/modules/messaging/application/outbox-publisher';
import { MikroOrmOutboxStore } from '../../../src/modules/messaging/infrastructure/mikro-orm-outbox.store';
import { MetricsRegistry } from '../../../src/shared/observability/metrics';
import type { OperationLog } from '../../../src/shared/observability/structured-log';
import { SqsEventTransport } from '../../../src/modules/messaging/infrastructure/sqs/sqs-event-transport';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, testSqsClient, type TestQueues } from '../support/sqs-test-queues';

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

/** Records every send per event id, so a test can prove that no event was transmitted twice by the publisher. */
class CountingTransport implements OutboxTransport {
  readonly sendsByEvent = new Map<string, number>();
  failuresRemaining = 0;

  constructor(private readonly inner: OutboxTransport) {}

  async publish(message: Parameters<OutboxTransport['publish']>[0]): Promise<void> {
    this.sendsByEvent.set(message.id, (this.sendsByEvent.get(message.id) ?? 0) + 1);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('simulated broker outage');
    }
    await this.inner.publish(message);
  }
}

function transportFor(): CountingTransport {
  return new CountingTransport(new SqsEventTransport(new SqsQueue(sqs, queues.eventsQueueUrl)));
}

function publisherFor(
  transport: OutboxTransport,
  clock: () => Date = () => NOW,
  batchSize = 10,
  logger?: (entry: OperationLog) => void,
) {
  return new OutboxPublisher({
    store: new MikroOrmOutboxStore(database.orm),
    transport,
    clock,
    newLeaseToken: randomUUID,
    leaseDurationMs: 30_000,
    batchSize,
    metrics,
    logger,
  });
}

/** Commits a wallet opening and one BET, which produces committed outbox events. */
async function committedEvents(): Promise<void> {
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '500.00', currency: 'BRL' }),
  });
  await processWager.execute({
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

async function pendingCount(): Promise<number> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(
      `SELECT count(*)::text AS n FROM outbox_messages WHERE published_at IS NULL`,
    )) as Array<{ n: string }>;
  return Number(rows[0]?.n ?? 0);
}

describe('OutboxPublisher', () => {
  test('publishes each committed event once, and marks it published', async () => {
    await committedEvents();
    const transport = transportFor();

    while ((await publisherFor(transport).publishOnce()) > 0) {
      // drain until nothing is due
    }

    expect(await pendingCount()).toBe(0);
    expect(metrics.snapshot().summaries['outbox_lag_seconds']?.count).toBeGreaterThanOrEqual(1);
    expect(metrics.snapshot().summaries['outbox_claim_ms']?.count).toBeGreaterThanOrEqual(1);
    expect(metrics.snapshot().summaries['outbox_publish_ms']?.count).toBeGreaterThanOrEqual(1);
    for (const sends of transport.sendsByEvent.values()) {
      expect(sends).toBe(1);
    }
  });

  test('concurrent publishers claim disjoint events, so no event is sent twice', async () => {
    for (let index = 0; index < 4; index += 1) {
      await committedEvents();
    }
    const transport = transportFor();
    const publishers = Array.from({ length: 4 }, () => publisherFor(transport, () => NOW, 3));

    await Promise.all(
      publishers.map(async (publisher) => {
        while ((await publisher.publishOnce()) > 0) {
          // each publisher drains its share
        }
      }),
    );

    expect(await pendingCount()).toBe(0);
    expect([...transport.sendsByEvent.values()].every((sends) => sends === 1)).toBe(true);
  });

  test('a failed broker send is retried only after its backoff has elapsed', async () => {
    await committedEvents();
    const transport = transportFor();
    // Every event pending now fails its first send, so the whole batch is in backoff.
    transport.failuresRemaining = await pendingCount();
    const pending = transport.failuresRemaining;
    expect(pending).toBeGreaterThan(0);
    const later = (ms: number) => () => new Date(NOW.getTime() + ms);

    expect(await publisherFor(transport, later(0)).publishOnce()).toBe(0);
    expect(await publisherFor(transport, later(500)).publishOnce()).toBe(0);
    expect(await publisherFor(transport, later(1_000)).publishOnce()).toBe(pending);
  });

  test('an event leased by a crashed publisher is published once its lease expires', async () => {
    await committedEvents();
    const store = new MikroOrmOutboxStore(database.orm);
    const crashed = await store.claimDue({
      now: NOW,
      leaseUntil: new Date(NOW.getTime() + 30_000),
      token: randomUUID(),
      limit: 1,
    });
    expect(crashed).toHaveLength(1);
    const transport = transportFor();

    const crashedId = crashed[0]?.id ?? '';
    await publisherFor(transport, () => NOW).publishOnce();
    expect(transport.sendsByEvent.has(crashedId)).toBe(false);

    const afterExpiry = new Date(NOW.getTime() + 31_000);
    await publisherFor(transport, () => afterExpiry).publishOnce();

    expect(transport.sendsByEvent.get(crashedId)).toBe(1);
  });

  test('a publisher stalled past its lease loses the event to a successor, and its late mark is refused', async () => {
    await committedEvents();
    const transport = transportFor();
    let now = NOW;
    const successor = publisherFor(transport, () => now);
    let successorPublished = -1;
    const stalled: OutboxTransport = {
      publish: async (message) => {
        // Slow, not crashed: the lease expires while this send is in flight, and a successor takes over.
        now = new Date(NOW.getTime() + 31_000);
        successorPublished = await successor.publishOnce();
        await transport.publish(message);
      },
    };
    const before = metrics.snapshot().counters['outbox_lost_lease_total'] ?? 0;

    const stalledPublished = await publisherFor(stalled, () => NOW, 1).publishOnce();

    expect(successorPublished).toBeGreaterThan(0);
    expect(stalledPublished).toBe(0);
    expect(metrics.snapshot().counters['outbox_lost_lease_total']).toBe(before + 1);
    const sentTwice = [...transport.sendsByEvent.entries()].filter(([, sends]) => sends === 2);
    expect(sentTwice).toHaveLength(1);
    const doubledId = sentTwice[0]?.[0] ?? '';
    const rows = await database.orm.em.getConnection().execute(
      `SELECT published_at IS NOT NULL AS published, lease_token IS NULL AS unleased
         FROM outbox_messages WHERE id = ?`,
      [doubledId],
    );
    expect(rows).toEqual([{ published: true, unleased: true }]);
  });

  test('a publisher that lost its lease cannot mark the event published', async () => {
    await committedEvents();
    const store = new MikroOrmOutboxStore(database.orm);
    const staleToken = randomUUID();
    const [event] = await store.claimDue({
      now: NOW,
      leaseUntil: new Date(NOW.getTime() + 1_000),
      token: staleToken,
      limit: 1,
    });
    if (!event) throw new Error('an event must be claimable');
    await store.claimDue({
      now: new Date(NOW.getTime() + 2_000),
      leaseUntil: new Date(NOW.getTime() + 32_000),
      token: randomUUID(),
      limit: 50,
    });

    const completed = await store.complete(event, staleToken, NOW);

    expect(completed).toBe(false);
  });

  test('a publisher whose lease was taken over counts the refused mark and does not report success', async () => {
    await committedEvents();
    const real = new MikroOrmOutboxStore(database.orm);
    let refusedOnce = false;
    const store = {
      claimDue: (request: Parameters<typeof real.claimDue>[0]) => real.claimDue(request),
      complete: (message: Parameters<typeof real.complete>[0], token: string, at: Date) => {
        if (refusedOnce) {
          return real.complete(message, token, at);
        }
        refusedOnce = true;
        return Promise.resolve(false);
      },
      reschedule: (message: Parameters<typeof real.reschedule>[0], token: string) =>
        real.reschedule(message, token),
    };
    const before = metrics.snapshot().counters['outbox_lost_lease_total'] ?? 0;
    const publisher = new OutboxPublisher({
      store,
      transport: transportFor(),
      clock: () => NOW,
      newLeaseToken: randomUUID,
      leaseDurationMs: 30_000,
      batchSize: 1,
      metrics,
    });

    const published = await publisher.publishOnce();

    expect(published).toBe(0);
    expect(metrics.snapshot().counters['outbox_lost_lease_total']).toBe(before + 1);
  });

  test('a failed broker send is logged with its error class, and never with its message', async () => {
    await committedEvents();
    const transport = transportFor();
    transport.failuresRemaining = await pendingCount();
    const logged: OperationLog[] = [];

    await publisherFor(
      transport,
      () => NOW,
      10,
      (entry) => logged.push(entry),
    ).publishOnce();

    expect(logged.length).toBeGreaterThan(0);
    for (const entry of logged) {
      expect(entry).toMatchObject({
        operation: 'outbox.publish',
        status: 'failed',
        errorName: 'Error',
      });
      expect(entry.messageId).toBeDefined();
    }
    expect(JSON.stringify(logged)).not.toContain('simulated broker outage');
  });
});

/** The `id` column of each row. A row without one is a broken query, so the test fails there. */
function idsOf(rows: unknown): string[] {
  if (!Array.isArray(rows)) {
    throw new Error('Expected a list of rows');
  }
  return rows.map((row: unknown) => {
    if (typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string') {
      return row.id;
    }
    throw new Error('A row has no text id');
  });
}

/** A promise that a test resolves on purpose. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Holds one event inside the transport until the test releases it, so the test sets the order of sends. */
class HeldTransport implements OutboxTransport {
  readonly sent: string[] = [];
  readonly entered = deferred();
  readonly released = deferred();

  constructor(private readonly heldId: string) {}

  async publish(message: Parameters<OutboxTransport['publish']>[0]): Promise<void> {
    if (message.id === this.heldId) {
      this.entered.resolve();
      await this.released.promise;
    }
    this.sent.push(message.id);
  }
}

class RecordingTransport implements OutboxTransport {
  readonly sent: string[] = [];

  async publish(message: Parameters<OutboxTransport['publish']>[0]): Promise<void> {
    this.sent.push(message.id);
  }
}

describe('OutboxPublisher: order across publishers', () => {
  test("two publishers can send one wallet's events out of commit order, so no order is promised across them", async () => {
    // Earlier tests may leave due events. Drain them, so only this test's events are pending.
    const drain = publisherFor(transportFor());
    while ((await drain.publishOnce()) > 0) {
      // Each pass publishes what is due. The loop ends when nothing is due.
    }

    const unitOfWork = new MikroOrmFinancialUnitOfWork(database.orm);
    const at = (instant: Date) => ({ unitOfWork, clock: () => instant, newId: randomUUID });
    const playerId = `player-${randomUUID()}`;
    const { walletId } = await new OpenWallet(at(new Date(NOW.getTime() - 3_000))).execute({
      playerId,
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    await drain.publishOnce();
    const bet = (instant: Date) =>
      new ProcessWagerTransaction(at(instant)).execute({
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
    // Two BETs commit at different instants. Each produces a balance event for the wallet, and an
    // event for its transaction, which belongs to another aggregate.
    await bet(new Date(NOW.getTime() - 2_000));
    await bet(new Date(NOW.getTime() - 1_000));

    const connection = database.orm.em.getConnection();
    const walletEvents = idsOf(
      await connection.execute(
        `SELECT id::text AS id FROM outbox_messages
        WHERE aggregate_id = ? AND event_type = 'WalletBalanceChanged' AND published_at IS NULL
        ORDER BY occurred_at`,
        [walletId],
      ),
    );
    expect(walletEvents).toHaveLength(2);
    const earlierCommit = walletEvents[0] ?? '';
    const laterCommit = walletEvents[1] ?? '';
    // Only the wallet's events are claimed in this test. The transaction events wait out of the window.
    await connection.execute(
      `UPDATE outbox_messages SET next_attempt_at = next_attempt_at + interval '1 day'
        WHERE published_at IS NULL AND aggregate_id <> ?`,
      [walletId],
    );

    // Publisher A claims the earlier commit, and stops inside the transport, holding its lease.
    const held = new HeldTransport(earlierCommit);
    const inFlight = publisherFor(held, () => NOW, 1).publishOnce();
    await held.entered.promise;

    // Publisher B claims the later commit while A is in flight, and sends it first.
    const other = new RecordingTransport();
    expect(await publisherFor(other, () => NOW, 1).publishOnce()).toBe(1);
    held.released.resolve();
    expect(await inFlight).toBe(1);

    // The later commit reached the broker first. Consumers order one wallet's events by walletVersion.
    expect([...other.sent, ...held.sent]).toEqual([laterCommit, earlierCommit]);
  });
});
