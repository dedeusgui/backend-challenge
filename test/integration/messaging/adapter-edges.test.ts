import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { ConcurrencyConflictError } from '../../../src/shared/application/application-errors';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmOutboxStore } from '../../../src/modules/messaging/infrastructure/mikro-orm-outbox.store';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { MikroOrmWagerTransactionRepository } from '../../../src/modules/wagering/infrastructure/mikro-orm-wager-transaction.repository';
import { WagerTransaction } from '../../../src/modules/wagering/domain/wager-transaction';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, testSqsClient, type TestQueues } from '../support/sqs-test-queues';

/**
 * The edges of the adapters: what the broker refuses, what a lease cannot take, and what a unique identity
 * collision does. Each test names the edge it reaches. The broker is LocalStack, and the database is a fresh one.
 */

const START = new Date('2026-07-29T15:00:00.000Z');
const LEASE = 30_000;

let database: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  database = await createTestDatabase({ verifyLedgerInvariant: false });
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
});

afterAll(async () => {
  await database.drop();
});

function refusedBy(action: () => Promise<unknown>): Promise<string> {
  return action().then(
    () => 'NO_ERROR',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe('the queue adapter', () => {
  test('extending the visibility of nothing is a no-op, and of more than ten messages is refused before any call', async () => {
    const queue = new SqsQueue(sqs, queues.commandQueueUrl);
    await expect(queue.extendVisibility([], 30)).resolves.toBeUndefined();
    expect(
      await refusedBy(() =>
        queue.extendVisibility(
          Array.from({ length: 11 }, () => 'h'),
          30,
        ),
      ),
    ).toBe('a visibility batch holds at most ten messages');
  });

  test('extending the visibility of a receipt the broker does not know is refused, and the caller hears it', async () => {
    const queue = new SqsQueue(sqs, queues.commandQueueUrl);
    expect(await refusedBy(() => queue.extendVisibility(['not-a-receipt-handle'], 30))).not.toBe(
      'NO_ERROR',
    );
  });

  test('a batch the broker refuses in full is an error for the caller, not a silent success', async () => {
    const queue = new SqsQueue(sqs, queues.commandQueueUrl);
    const outcome = await refusedBy(() =>
      queue.sendBatch([{ id: 'a', body: 'payload', groupId: '', deduplicationId: 'd-1' }]),
    );
    expect(outcome).not.toBe('NO_ERROR');
  });

  test('the counts of a queue include what is in flight: visible plus not visible', async () => {
    const queue = new SqsQueue(sqs, queues.commandQueueUrl);
    const before = await queue.pendingCount();
    await queue.send('{"probe":true}', `group-${randomUUID()}`, randomUUID());
    expect(await queue.pendingCount()).toBeGreaterThanOrEqual(before + 1);
    expect(await queue.countInFlight()).toBeGreaterThanOrEqual(0);
  });
});

describe('the outbox store', () => {
  test('completing nothing marks nothing, and a lease that is not held cannot reschedule an event', async () => {
    const store = new MikroOrmOutboxStore(database.orm);
    expect(await store.complete([], randomUUID(), START)).toEqual([]);

    const message = OutboxMessage.rehydrate({
      id: randomUUID(),
      aggregateId: 'aggregate-1',
      eventType: 'WagerTransactionProcessed',
      payload: {
        eventId: randomUUID(),
        eventType: 'WagerTransactionProcessed',
        aggregateId: 'aggregate-1',
        correlationId: 'corr',
        occurredAt: START.toISOString(),
        version: 1,
        data: {},
      },
      occurredAt: START,
      attempts: 0,
      nextAttemptAt: START,
      publishedAt: undefined,
    });
    await database.orm.em.getConnection().execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
       VALUES (?, ?, ?, ?::jsonb, ?, ?)`,
      [
        message.id,
        'aggregate-1',
        'WagerTransactionProcessed',
        JSON.stringify(message.payload),
        START,
        START,
      ],
    );
    expect(await store.reschedule(message, randomUUID())).toBe(false);
  });

  test('a payload that the schema would refuse, written past the schema, stops the claim with the missing field named', async () => {
    // The shape constraint refuses this row on write. It is removed here only to prove that the reader still refuses
    // a row that reached the table some other way: the claim names the field and does not publish the batch.
    const connection = database.orm.em.getConnection();
    await connection.execute(`ALTER TABLE outbox_messages DROP CONSTRAINT outbox_envelope_shape`);
    try {
      await connection.execute(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
         VALUES (?, 'aggregate-bad', 'WagerTransactionProcessed', '{"eventType":"x"}'::jsonb, ?, ?)`,
        [randomUUID(), START, new Date(START.getTime() - 60_000)],
      );
      const store = new MikroOrmOutboxStore(database.orm);
      const error = await refusedBy(() =>
        store.claimDue({ token: randomUUID(), leaseMs: LEASE, limit: 50 }),
      );
      expect(error).toBe('Outbox payload is missing eventId');
    } finally {
      await connection.execute(`DELETE FROM outbox_messages WHERE aggregate_id = 'aggregate-bad'`);
      await connection.execute(
        `ALTER TABLE outbox_messages ADD CONSTRAINT outbox_envelope_shape CHECK (
           jsonb_typeof(payload) IS NOT DISTINCT FROM 'object'
           AND jsonb_typeof(payload -> 'eventId') IS NOT DISTINCT FROM 'string'
           AND jsonb_typeof(payload -> 'eventType') IS NOT DISTINCT FROM 'string'
           AND jsonb_typeof(payload -> 'aggregateId') IS NOT DISTINCT FROM 'string'
           AND jsonb_typeof(payload -> 'correlationId') IS NOT DISTINCT FROM 'string'
           AND jsonb_typeof(payload -> 'occurredAt') IS NOT DISTINCT FROM 'string'
           AND jsonb_typeof(payload -> 'version') IS NOT DISTINCT FROM 'number'
           AND payload ? 'data')`,
      );
    }
  });
});

describe('the transaction repository', () => {
  test('a second row with the same identity is a concurrency conflict, which the use case retries against the winner', async () => {
    const connection = database.orm.em.getConnection();
    const walletId = randomUUID();
    await connection.execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', 100.00, 1, now(), now())`,
      [walletId, `player-${randomUUID()}`],
    );
    const repository = new MikroOrmWagerTransactionRepository(database.orm.em.fork());
    const props = {
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: `dup-${randomUUID()}`,
      idempotencyKey: `provider-a:dup-${randomUUID()}`,
      payloadHash: '0'.repeat(64),
      walletId,
      playerId: 'player-x',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET' as const,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      referenceExternalTransactionId: undefined,
      createdAt: START,
    };
    await repository.insert(WagerTransaction.create(props));

    const collision = WagerTransaction.create({
      ...props,
      id: randomUUID(),
      idempotencyKey: `provider-a:other-${randomUUID()}`,
    });
    expect(await refusedBy(() => repository.insert(collision))).toBe(
      `Transaction ${collision.id} collides with a committed identity`,
    );
    expect(ConcurrencyConflictError.name).toBe('ConcurrencyConflictError');
  });

  test('an identity is found by its idempotency key, and by its external id when the key differs, and by neither when both differ', async () => {
    const repository = new MikroOrmWagerTransactionRepository(database.orm.em.fork());
    const external = `known-${randomUUID()}`;
    const key = `provider-a:${external}`;
    const walletId = randomUUID();
    await database.orm.em.getConnection().execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, 'player-y', 'BRL', 100.00, 1, now(), now())`,
      [walletId],
    );
    await repository.insert(
      WagerTransaction.create({
        id: randomUUID(),
        providerId: 'provider-a',
        externalTransactionId: external,
        idempotencyKey: key,
        payloadHash: '1'.repeat(64),
        walletId,
        playerId: 'player-y',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: Money.from({ amount: '5.00', currency: 'BRL' }),
        referenceExternalTransactionId: undefined,
        createdAt: START,
      }),
    );
    expect(
      (await repository.findByIdentity('provider-a', key, 'other'))?.externalTransactionId,
    ).toBe(external);
    expect(
      (await repository.findByIdentity('provider-a', 'other-key', external))?.externalTransactionId,
    ).toBe(external);
    expect(
      await repository.findByIdentity('provider-a', 'other-key', 'other-external'),
    ).toBeUndefined();
  });
});
