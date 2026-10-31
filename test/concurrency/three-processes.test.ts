import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SqsQueue } from '../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { testSqsClient } from '../integration/support/sqs-test-queues';
import { ProcessCluster } from './support/process-cluster';
import { CreateApiClient } from '../../src/modules/auth/application/create-api-client.use-case';
import { MikroOrmApiClientRepository } from '../../src/modules/auth/infrastructure/mikro-orm-api-client.repository';

/**
 * Distributed proof. Three independent API processes and background workers share
 * one PostgreSQL database and one LocalStack. Every request below crosses process
 * boundaries; nothing is shared in memory.
 */

let cluster: ProcessCluster;
let apis: string[];
let operatorKey = '';
let providerKey = '';

/** Wallets are for the operator. Wagering calls are for provider-a, the provider these tests use. */
function authFor(path: string): Record<string, string> {
  const key = path.startsWith('/wagering') ? providerKey : operatorKey;
  return { authorization: `Bearer ${key}` };
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authFor(path), ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  const rows = (await cluster.database.orm.em.getConnection().execute(sql, params)) as Array<
    Record<string, string>
  >;
  return Object.values(rows[0] ?? {})[0] ?? '';
}

async function balanceOf(walletId: string): Promise<string> {
  return scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [walletId]);
}

async function ledgerSumOf(walletId: string): Promise<string> {
  return scalar(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text
       FROM wallet_ledger_entries WHERE wallet_id = ?`,
    [walletId],
  );
}

async function createWallet(
  api: string,
  amount: string,
): Promise<{ walletId: string; playerId: string }> {
  const playerId = randomUUID();
  const created = await postJson(api, '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(created.status).toBe(201);
  return { walletId: created.body.id as string, playerId };
}

function bet(
  wallet: { walletId: string; playerId: string },
  externalTransactionId: string,
  amount: string,
) {
  return {
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
    headers: { 'idempotency-key': `provider-a:${externalTransactionId}` },
  };
}

beforeAll(async () => {
  cluster = await ProcessCluster.create();
  const clients = new CreateApiClient({
    repository: new MikroOrmApiClientRepository(cluster.database.orm),
    clock: () => new Date(),
    newId: randomUUID,
  });
  operatorKey = (await clients.execute({ name: 'operator', role: 'OPERATOR' })).apiKey;
  providerKey = (
    await clients.execute({ name: 'provider a', role: 'PROVIDER', providerId: 'provider-a' })
  ).apiKey;
  apis = [];
  for (const name of ['api-1', 'api-2', 'api-3']) {
    apis.push(await cluster.startApi(name));
  }
  cluster.startWorker('worker-1');
}, 120_000);

afterAll(async () => {
  await cluster.close();
}, 60_000);

describe('three independent API processes and a worker', () => {
  test('a hot wallet hit from two processes at once: one bet is applied, the other is rejected', async () => {
    const wallet = await createWallet(apis[0] as string, '100.00');
    const [first, second] = [
      bet(wallet, `hot-${randomUUID()}`, '80.00'),
      bet(wallet, `hot-${randomUUID()}`, '80.00'),
    ];

    const [a, b] = await Promise.all([
      postJson(apis[0] as string, '/wagering/transactions', first.body, first.headers),
      postJson(apis[1] as string, '/wagering/transactions', second.body, second.headers),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect(await balanceOf(wallet.walletId)).toBe('20.00');
    expect(await ledgerSumOf(wallet.walletId)).toBe('20.00');
  }, 60_000);

  test('fifty identical requests spread over three processes apply the debit exactly once', async () => {
    const wallet = await createWallet(apis[0] as string, '100.00');
    const request = bet(wallet, `same-${randomUUID()}`, '25.00');

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        postJson(
          apis[index % apis.length] as string,
          '/wagering/transactions',
          request.body,
          request.headers,
        ),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.every((response) => response.status === 201 || response.status === 200)).toBe(
      true,
    );
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(await balanceOf(wallet.walletId)).toBe('75.00');
    expect(await ledgerSumOf(wallet.walletId)).toBe('75.00');
  }, 60_000);

  test('distinct wallets operated in parallel across processes all succeed and stay consistent', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createWallet(apis[index % apis.length] as string, '100.00'),
      ),
    );

    const responses = await Promise.all(
      wallets.map((wallet, index) => {
        const request = bet(wallet, `distinct-${randomUUID()}`, '30.00');
        return postJson(
          apis[index % apis.length] as string,
          '/wagering/transactions',
          request.body,
          request.headers,
        );
      }),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.walletId)).toBe('70.00');
      expect(await ledgerSumOf(wallet.walletId)).toBe('70.00');
    }
  }, 60_000);

  test('the worker publishes every committed outbox event to the events queue, each one once', async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (
        (await scalar(`SELECT count(*)::text FROM outbox_messages WHERE published_at IS NULL`)) ===
        '0'
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const published = Number(
      await scalar(`SELECT count(*)::text FROM outbox_messages WHERE published_at IS NOT NULL`),
    );
    expect(published).toBeGreaterThan(0);

    const events = new SqsQueue(testSqsClient(), cluster.queues.eventsQueueUrl);
    const eventIds: string[] = [];
    for (let round = 0; round < 200 && eventIds.length < published; round += 1) {
      const batch = await events.receive({
        maxMessages: 10,
        waitSeconds: 1,
        visibilityTimeoutSeconds: 30,
      });
      for (const message of batch) {
        eventIds.push((JSON.parse(message.body) as { eventId: string }).eventId);
        await events.acknowledge(message.receiptHandle);
      }
    }

    expect(eventIds.length).toBe(published);
    expect(new Set(eventIds).size).toBe(published);
  }, 90_000);
});

describe('process lifecycle', () => {
  test('SIGTERM stops the worker gracefully with exit code 0', async () => {
    const worker = cluster.processes.find((managed) => managed.name === 'worker-1');
    if (!worker) throw new Error('worker-1 must be running');

    worker.process.kill('SIGTERM');
    const exitCode = await Promise.race([
      worker.process.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
    ]);

    expect(exitCode).toBe(0);
  }, 30_000);

  test('a worker that crashes after commit and before ACK is recovered by a restarted worker, without a second effect', async () => {
    const playerId = randomUUID();
    const created = await postJson(apis[0] as string, '/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const walletId = created.body.id as string;
    const externalTransactionId = `crash-${randomUUID()}`;
    const message = JSON.stringify({
      messageId: `msg-${randomUUID()}`,
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
        money: { amount: '25.00', currency: 'BRL' },
      },
    });
    await new SqsQueue(testSqsClient(), cluster.queues.commandQueueUrl).send(
      message,
      walletId,
      randomUUID(),
    );

    const crashing = cluster.startWorker('crashing-worker', 'test/support/crashing-worker.ts', {
      CONSUMER_VISIBILITY_SECONDS: '2',
    });
    const exitCode = await Promise.race([
      crashing.process.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
    ]);

    expect(exitCode).toBe(137);
    expect(
      await scalar(
        `SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [walletId],
      ),
    ).toBe('1');

    cluster.startWorker('worker-2', 'src/worker.ts', { CONSUMER_VISIBILITY_SECONDS: '2' });
    // Observe the queue without receiving from it: this test must not compete with the worker for the message.
    const queue = new SqsQueue(testSqsClient(), cluster.queues.commandQueueUrl);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && (await queue.pendingCount()) > 0) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(await queue.pendingCount()).toBe(0);

    expect(await balanceOf(walletId)).toBe('75.00');
    expect(await ledgerSumOf(walletId)).toBe('75.00');
    expect(
      await scalar(
        `SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [walletId],
      ),
    ).toBe('1');
  }, 120_000);
});
