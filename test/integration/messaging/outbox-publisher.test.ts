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

function publisherFor(transport: OutboxTransport, clock: () => Date = () => NOW, batchSize = 10) {
  return new OutboxPublisher({
    store: new MikroOrmOutboxStore(database.orm),
    transport,
    clock,
    newLeaseToken: randomUUID,
    leaseDurationMs: 30_000,
    batchSize,
    metrics,
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
});
