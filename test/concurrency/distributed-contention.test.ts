import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CreateApiClient } from '../../src/modules/auth/application/create-api-client.use-case';
import { MikroOrmApiClientRepository } from '../../src/modules/auth/infrastructure/mikro-orm-api-client.repository';
import { SqsQueue } from '../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { OpenWallet } from '../../src/modules/wallet/application/open-wallet.use-case';
import { Money } from '../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { testSqsClient } from '../integration/support/sqs-test-queues';
import { ProcessCluster, type ManagedProcess } from './support/process-cluster';

/**
 * Contention between independent processes, each with its own connections and its own
 * wallet lock. Every test starts the same operation from several processes at once. Exactly
 * one of them may have the effect; the rest must be replays, conflicts or rejections.
 */

type Json = Record<string, unknown>;

interface HttpResult {
  status: number;
  body: Json;
}

interface Operation {
  kind: string;
  externalTransactionId: string;
  amount: string;
  reference?: string;
}

interface Wallet {
  walletId: string;
  playerId: string;
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`condition not met within ${timeoutMs} ms`);
  })();
}

/** Resolves with the exit code, or 'timeout'. A process killed by a signal has no exit code. */
function exitOrTimeout(
  managed: ManagedProcess,
  timeoutMs: number,
): Promise<number | null | 'timeout'> {
  return Promise.race([
    managed.process.exited,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]);
}

/** The metrics line a worker prints when it stops gracefully. */
function metricsOf(managed: ManagedProcess): Record<string, number> {
  const line = managed
    .recentOutput()
    .split('\n')
    .find((candidate) => candidate.includes('"type":"metrics"'));
  if (line === undefined) throw new Error(`${managed.name} printed no metrics`);
  return (JSON.parse(line) as { counters: Record<string, number> }).counters;
}

function probesOf(cluster: ProcessCluster) {
  const em = () => cluster.database.orm.em.getConnection();
  return {
    scalar: async (sql: string, params: unknown[] = []): Promise<string> => {
      const rows = (await em().execute(sql, params)) as Array<Record<string, string>>;
      return Object.values(rows[0] ?? {})[0] ?? '';
    },
    sendCommand: (wallet: Wallet, operation: Operation) =>
      new SqsQueue(testSqsClient(), cluster.queues.commandQueueUrl).send(
        JSON.stringify({
          messageId: `msg-${randomUUID()}`,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-a',
            externalTransactionId: operation.externalTransactionId,
            idempotencyKey: `provider-a:${operation.externalTransactionId}`,
            playerId: wallet.playerId,
            walletId: wallet.walletId,
            roundId: 'round-987',
            gameId: 'fortune-chimp',
            kind: operation.kind,
            money: { amount: operation.amount, currency: 'BRL' },
          },
        }),
        wallet.walletId,
        randomUUID(),
      ),
  };
}

const NOW = new Date('2026-07-29T15:00:00.000Z');

describe('distributed contention: three API processes and two workers', () => {
  let cluster: ProcessCluster;
  let probes: ReturnType<typeof probesOf>;
  let apis: string[];
  let operatorKey = '';
  let providerKey = '';
  let workers: ManagedProcess[];
  let workerCounters: Array<Record<string, number>> = [];

  beforeAll(async () => {
    cluster = await ProcessCluster.create();
    probes = probesOf(cluster);
    const clients = new CreateApiClient({
      repository: new MikroOrmApiClientRepository(cluster.database.orm),
      clock: () => NOW,
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
    workers = [cluster.startWorker('worker-a'), cluster.startWorker('worker-b')];
  }, 120_000);

  afterAll(async () => {
    await cluster.close();
  }, 60_000);

  async function openWallet(amount: string): Promise<Wallet> {
    const playerId = randomUUID();
    const response = await postJson(
      apis[0] as string,
      '/wallets',
      { playerId, initialBalance: { amount, currency: 'BRL' } },
      { authorization: `Bearer ${operatorKey}` },
    );
    expect(response.status).toBe(201);
    return { walletId: response.body.id as string, playerId };
  }

  /** The request a provider sends for one operation, from one of the API processes. */
  function submit(api: string, wallet: Wallet, operation: Operation): Promise<HttpResult> {
    return postJson(
      api,
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: operation.externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: operation.kind,
        money: { amount: operation.amount, currency: 'BRL' },
        ...(operation.reference === undefined
          ? {}
          : { referenceExternalTransactionId: operation.reference }),
      },
      {
        authorization: `Bearer ${providerKey}`,
        'idempotency-key': `provider-a:${operation.externalTransactionId}`,
      },
    );
  }

  test('the same operation from three processes at once: one 201, two replays of that same transaction, one debit', async () => {
    const wallet = await openWallet('100.00');
    const operation: Operation = {
      kind: 'BET',
      externalTransactionId: `same-${randomUUID()}`,
      amount: '25.00',
    };

    const responses = await Promise.all(apis.map((api) => submit(api, wallet, operation)));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(
      await probes.scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId]),
    ).toBe('75.00');
    expect(
      await probes.scalar(
        `SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [wallet.walletId],
      ),
    ).toBe('1');
  }, 60_000);

  test('the same idempotency key with three different payloads from three processes: one applies, two are conflicts', async () => {
    const wallet = await openWallet('100.00');
    const externalTransactionId = `conflict-${randomUUID()}`;
    const amounts = ['10.00', '20.00', '30.00'];

    const responses = await Promise.all(
      apis.map((api, index) =>
        submit(api, wallet, {
          kind: 'BET',
          externalTransactionId,
          amount: amounts[index] as string,
        }),
      ),
    );

    const applied = responses.filter((response) => response.status === 201);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(applied).toHaveLength(1);
    expect(conflicts).toHaveLength(2);
    expect(conflicts.every((response) => response.body.error !== undefined)).toBe(true);
    // The balance is the one the winning request saw, and only its debit exists.
    const winner = applied[0]?.body.balance as { amount: string };
    expect(
      await probes.scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId]),
    ).toBe(winner.amount);
    expect(
      await probes.scalar(
        `SELECT count(*)::text FROM wager_transactions WHERE external_transaction_id = ?`,
        [externalTransactionId],
      ),
    ).toBe('1');
  }, 60_000);

  test('a refund and two rollbacks of one BET from three processes: exactly one reversal, the stake returns once', async () => {
    const wallet = await openWallet('100.00');
    const bet = `reversed-${randomUUID()}`;
    expect(
      (
        await submit(apis[0] as string, wallet, {
          kind: 'BET',
          externalTransactionId: bet,
          amount: '25.00',
        })
      ).status,
    ).toBe(201);

    const responses = await Promise.all([
      submit(apis[0] as string, wallet, {
        kind: 'REFUND',
        externalTransactionId: `r-${randomUUID()}`,
        amount: '25.00',
        reference: bet,
      }),
      submit(apis[1] as string, wallet, {
        kind: 'ROLLBACK',
        externalTransactionId: `rb-${randomUUID()}`,
        amount: '25.00',
        reference: bet,
      }),
      submit(apis[2] as string, wallet, {
        kind: 'ROLLBACK',
        externalTransactionId: `rb-${randomUUID()}`,
        amount: '25.00',
        reference: bet,
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 422, 422]);
    const refused = responses.filter((response) => response.status === 422);
    expect(refused.map((response) => response.body.failureCode)).toEqual([
      'REFERENCE_ALREADY_REVERSED',
      'REFERENCE_ALREADY_REVERSED',
    ]);
    expect(
      await probes.scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId]),
    ).toBe('100.00');
    expect(
      await probes.scalar(
        `SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'`,
        [wallet.walletId],
      ),
    ).toBe('2');
  }, 60_000);

  test('a WIN, a REFUND and a LOSS on one BET from three processes: exactly one result applies', async () => {
    const wallet = await openWallet('100.00');
    const bet = `settle-${randomUUID()}`;
    expect(
      (
        await submit(apis[0] ?? '', wallet, {
          kind: 'BET',
          externalTransactionId: bet,
          amount: '25.00',
        })
      ).status,
    ).toBe(201);

    const responses = await Promise.all([
      submit(apis[0] ?? '', wallet, {
        kind: 'WIN',
        externalTransactionId: `win-${randomUUID()}`,
        amount: '40.00',
        reference: bet,
      }),
      submit(apis[1] ?? '', wallet, {
        kind: 'REFUND',
        externalTransactionId: `refund-${randomUUID()}`,
        amount: '25.00',
        reference: bet,
      }),
      submit(apis[2] ?? '', wallet, {
        kind: 'LOSS',
        externalTransactionId: `loss-${randomUUID()}`,
        amount: '0.00',
        reference: bet,
      }),
    ]);

    const winnerIndex = responses.findIndex((response) => response.status === 201);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const refusedCodes = responses
      .filter((response) => response.status === 422)
      .map((response) => String(response.body.failureCode));
    expect(refusedCodes).toHaveLength(2);
    for (const code of refusedCodes) {
      expect(['REFERENCE_ALREADY_SETTLED', 'REFERENCE_ALREADY_REVERSED']).toContain(code);
    }
    // The result that applied decides the balance: a WIN credits 40.00, a REFUND returns 25.00, a LOSS moves nothing.
    const expectedBalance = ['115.00', '100.00', '75.00'][winnerIndex] ?? 'no winner';
    expect(
      await probes.scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId]),
    ).toBe(expectedBalance);
  }, 60_000);

  test('a WIN, a LOSS and a second WIN on one BET from three processes: exactly one result applies', async () => {
    const wallet = await openWallet('100.00');
    const bet = `result-${randomUUID()}`;
    expect(
      (
        await submit(apis[0] as string, wallet, {
          kind: 'BET',
          externalTransactionId: bet,
          amount: '25.00',
        })
      ).status,
    ).toBe(201);

    const results: Operation[] = [
      { kind: 'WIN', externalTransactionId: `w1-${randomUUID()}`, amount: '40.00', reference: bet },
      { kind: 'LOSS', externalTransactionId: `l-${randomUUID()}`, amount: '0.00', reference: bet },
      { kind: 'WIN', externalTransactionId: `w2-${randomUUID()}`, amount: '60.00', reference: bet },
    ];
    const responses = await Promise.all(
      results.map((operation, index) => submit(apis[index] as string, wallet, operation)),
    );

    const appliedIndex = responses.findIndex((response) => response.status === 201);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 422).map((r) => r.body.failureCode),
    ).toEqual(['REFERENCE_ALREADY_SETTLED', 'REFERENCE_ALREADY_SETTLED']);
    // The BET cost 25.00. The applied result decides the balance: a LOSS moves nothing.
    const expectedBalance = { WIN: { '40.00': '115.00', '60.00': '135.00' }, LOSS: '75.00' };
    const applied = results[appliedIndex];
    const balance =
      applied?.kind === 'WIN'
        ? expectedBalance.WIN[applied.amount as '40.00' | '60.00']
        : expectedBalance.LOSS;
    expect(
      await probes.scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId]),
    ).toBe(balance);
  }, 60_000);

  test('forty operations on one hot wallet, queued and taken by two workers: each applied exactly once', async () => {
    const wallet = await openWallet('1000.00');
    const operations = Array.from({ length: 40 }, () => ({
      kind: 'BET',
      externalTransactionId: `queued-${randomUUID()}`,
      amount: '5.00',
    }));
    for (const operation of operations) {
      await probes.sendCommand(wallet, operation);
    }

    await waitFor(
      async () =>
        Number(
          await probes.scalar(
            `SELECT count(*)::text FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`,
            [wallet.walletId],
          ),
        ) === operations.length,
      90_000,
    );

    expect(
      await probes.scalar(
        `SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [wallet.walletId],
      ),
    ).toBe('40');
    expect(
      await probes.scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId]),
    ).toBe('800.00');
  }, 120_000);

  test('two publishers over one outbox: every committed event is sent once, and none is lost', async () => {
    await waitFor(
      async () =>
        (await probes.scalar(
          `SELECT count(*)::text FROM outbox_messages WHERE published_at IS NULL`,
        )) === '0',
      90_000,
    );
    const committed = Number(await probes.scalar(`SELECT count(*)::text FROM outbox_messages`));

    for (const worker of workers) {
      worker.process.kill('SIGTERM');
      expect(await exitOrTimeout(worker, 60_000)).toBe(0);
    }
    workerCounters = workers.map(metricsOf);
    const published = workerCounters.reduce(
      (sum, c) => sum + (c['outbox_published_total'] ?? 0),
      0,
    );
    const lostLease = workerCounters.reduce(
      (sum, c) => sum + (c['outbox_lost_lease_total'] ?? 0),
      0,
    );

    expect(committed).toBeGreaterThan(0);
    expect(published).toBe(committed);
    expect(lostLease).toBe(0);
  }, 180_000);

  test('no operation on a shared wallet needed a retry: the wallet lock serialises them in every process', async () => {
    const apiCounters = await Promise.all(
      apis.map(async (api) => {
        const response = await fetch(`${api}/metrics`, {
          headers: { authorization: `Bearer ${operatorKey}` },
        });
        return ((await response.json()) as { counters: Record<string, number> }).counters;
      }),
    );
    const all = [...apiCounters, ...workerCounters];
    // The processes did real work, so the zero below is not an empty measurement.
    expect(
      all.reduce((sum, c) => sum + (c['transactions_total{status="PROCESSED"}'] ?? 0), 0),
    ).toBeGreaterThan(40);
    // Without the lock, the version guard would refuse a racing write and the operation would retry.
    expect(all.reduce((sum, c) => sum + (c['concurrency_conflicts_total'] ?? 0), 0)).toBe(0);
  });
});

describe('a worker killed while another worker takes the same wallet', () => {
  let cluster: ProcessCluster;

  beforeAll(async () => {
    cluster = await ProcessCluster.create();
  }, 120_000);

  afterEach(async () => {
    for (const managed of cluster.processes) {
      if (managed.process.exitCode === null) managed.process.kill('SIGKILL');
    }
    await Promise.all(cluster.processes.map((managed) => managed.process.exited));
  });

  afterAll(async () => {
    await cluster.close();
  }, 60_000);

  test('the killed worker’s in-flight commands return and the survivor applies each exactly once', async () => {
    const probes = probesOf(cluster);
    const playerId = randomUUID();
    const opened = await new OpenWallet({
      unitOfWork: new MikroOrmFinancialUnitOfWork(cluster.database.orm),
      clock: () => NOW,
      newId: randomUUID,
    }).execute({ playerId, initialBalance: Money.from({ amount: '1000.00', currency: 'BRL' }) });
    const walletId = opened.walletId;
    const wallet = { walletId, playerId };
    const count = 30;
    for (let index = 0; index < count; index += 1) {
      await probes.sendCommand(wallet, {
        kind: 'BET',
        externalTransactionId: `kill-${index}-${randomUUID()}`,
        amount: '5.00',
      });
    }

    const doomed = cluster.startWorker('doomed', 'test/support/slow-worker.ts', {
      TRANSACTION_DELAY_MS: '200',
      CONSUMER_VISIBILITY_SECONDS: '2',
    });
    const survivor = cluster.startWorker('survivor', 'src/worker.ts', {
      CONSUMER_VISIBILITY_SECONDS: '2',
    });
    await waitFor(
      async () =>
        Number(
          await probes.scalar(
            `SELECT count(*)::text FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`,
            [walletId],
          ),
        ) >= 5,
      60_000,
    );
    doomed.process.kill('SIGKILL');
    await exitOrTimeout(doomed, 30_000);

    await waitFor(
      async () =>
        Number(
          await probes.scalar(
            `SELECT count(*)::text FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`,
            [walletId],
          ),
        ) === count,
      120_000,
    );
    expect(survivor.process.exitCode).toBeNull();
    expect(
      await probes.scalar(
        `SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [walletId],
      ),
    ).toBe(String(count));
    expect(await probes.scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [walletId])).toBe(
      '850.00',
    );
  }, 240_000);
});
