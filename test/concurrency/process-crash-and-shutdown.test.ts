import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SqsQueue } from '../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { CreateApiClient } from '../../src/modules/auth/application/create-api-client.use-case';
import { MikroOrmApiClientRepository } from '../../src/modules/auth/infrastructure/mikro-orm-api-client.repository';
import { OpenWallet } from '../../src/modules/wallet/application/open-wallet.use-case';
import { Money } from '../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { testSqsClient } from '../integration/support/sqs-test-queues';
import { ProcessCluster, type ManagedProcess } from './support/process-cluster';
import { required } from '../support/required';

/**
 * Process-level failure. The worker is a real Bun process, killed or stopped by the operating
 * system. Nothing is injected in memory, except the test-only entrypoints in test/support, which
 * stop the process at a chosen point and never run in production.
 */

const NOW = new Date('2026-07-29T15:00:00.000Z');

let cluster: ProcessCluster;
let openWallet: OpenWallet;

beforeAll(async () => {
  cluster = await ProcessCluster.create();
  openWallet = new OpenWallet({
    unitOfWork: new MikroOrmFinancialUnitOfWork(cluster.database.orm),
    clock: () => NOW,
    newId: randomUUID,
  });
}, 120_000);

/** A failed test must not leave a worker behind: it would consume the queue of the next test. */
afterEach(async () => {
  for (const managed of cluster.processes) {
    if (managed.process.exitCode === null) managed.process.kill('SIGKILL');
  }
  await Promise.all(cluster.processes.map((managed) => managed.process.exited));
});

afterAll(async () => {
  await cluster.close();
}, 60_000);

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  const rows = (await cluster.database.orm.em.getConnection().execute(sql, params)) as Array<
    Record<string, string>
  >;
  return required(Object.values(required(rows[0], 'a result row'))[0], 'a result column');
}

async function openWalletWith(amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = randomUUID();
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount, currency: 'BRL' }),
  });
  return { walletId, playerId };
}

async function sendBet(
  wallet: { walletId: string; playerId: string },
  externalTransactionId: string,
  amount: string,
): Promise<void> {
  const message = JSON.stringify({
    messageId: `msg-${randomUUID()}`,
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
      money: { amount, currency: 'BRL' },
    },
  });
  await new SqsQueue(testSqsClient(), cluster.queues.commandQueueUrl).send(
    message,
    wallet.walletId,
    randomUUID(),
  );
}

/** Resolves with the exit code, or 'timeout' when the process does not exit in time. */
function exitOrTimeout(managed: ManagedProcess, timeoutMs: number): Promise<number | 'timeout'> {
  return Promise.race([
    managed.process.exited,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]);
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

describe('a worker killed inside a transaction, before commit', () => {
  test('leaves no trace, and a restarted worker applies the command exactly once', async () => {
    const wallet = await openWalletWith('100.00');
    const externalTransactionId = `pre-commit-${randomUUID()}`;
    await sendBet(wallet, externalTransactionId, '25.00');

    const crashing = cluster.startWorker(
      'killed-before-commit',
      'test/support/crashing-before-commit-worker.ts',
      { CONSUMER_VISIBILITY_SECONDS: '2' },
    );
    expect(await exitOrTimeout(crashing, 30_000)).toBe(137);

    // Nothing of the killed transaction is visible: no balance change, no row, no event.
    expect(await scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId])).toBe(
      '100.00',
    );
    expect(
      await scalar(
        `SELECT count(*)::text FROM wager_transactions WHERE wallet_id = ? AND external_transaction_id = ?`,
        [wallet.walletId, externalTransactionId],
      ),
    ).toBe('0');
    expect(
      await scalar(`SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ?`, [
        wallet.walletId,
      ]),
    ).toBe('1');
    // The message was never acknowledged, so it is still in flight and will come back.
    expect(
      await new SqsQueue(testSqsClient(), cluster.queues.commandQueueUrl).countInFlight(),
    ).toBeGreaterThanOrEqual(1);

    const restarted = cluster.startWorker('restarted-after-kill', 'src/worker.ts', {
      CONSUMER_VISIBILITY_SECONDS: '2',
    });
    await waitFor(
      async () =>
        (await scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId])) ===
        '75.00',
      60_000,
    );

    expect(
      await scalar(
        `SELECT count(*)::text FROM wager_transactions WHERE wallet_id = ? AND external_transaction_id = ? AND status = 'PROCESSED'`,
        [wallet.walletId, externalTransactionId],
      ),
    ).toBe('1');
    expect(
      await scalar(
        `SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [wallet.walletId],
      ),
    ).toBe('1');

    // Each test stops the workers it started, so that the next one owns the queue.
    restarted.process.kill('SIGTERM');
    expect(await exitOrTimeout(restarted, 60_000)).toBe(0);
  }, 120_000);
});

describe('an HTTP process killed inside a transaction, before commit', () => {
  test('rolls back the wager and a retry applies it once', async () => {
    const wallet = await openWalletWith('100.00');
    const externalTransactionId = `http-pre-commit-${randomUUID()}`;
    const providerKey = (
      await new CreateApiClient({
        repository: new MikroOrmApiClientRepository(cluster.database.orm),
        clock: () => NOW,
        newId: randomUUID,
      }).execute({ name: 'crash-test-provider', role: 'PROVIDER', providerId: 'provider-a' })
    ).apiKey;
    const apiUrl = await cluster.startApi('http-killed-in-transaction');

    await cluster.database.orm.em.getConnection().execute(`
      CREATE FUNCTION test_pause_ledger_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(60);
        RETURN NEW;
      END;
      $$
    `);
    await cluster.database.orm.em.getConnection().execute(`
      CREATE TRIGGER test_pause_ledger_insert
      BEFORE INSERT ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION test_pause_ledger_insert()
    `);

    const requestBody = {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const headers = {
      authorization: `Bearer ${providerKey}`,
      'content-type': 'application/json',
      'idempotency-key': `provider-a:${externalTransactionId}`,
    };
    const request = fetch(`${apiUrl}/wagering/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    }).then(
      async (response) => ({ status: response.status, body: await response.json() }),
      (error: unknown) => ({ error }),
    );
    const api = required(
      cluster.processes.find(({ name }) => name === 'http-killed-in-transaction'),
      'the HTTP process under test',
    );

    try {
      await waitFor(
        async () =>
          (await scalar(`
            SELECT count(*)::text
            FROM pg_stat_activity
            WHERE wait_event = 'PgSleep'
              AND query ILIKE '%wallet_ledger_entries%'
          `)) === '1',
        30_000,
      );
      api.process.kill('SIGKILL');
      expect(await exitOrTimeout(api, 30_000)).toBe(137);
      expect('error' in (await request)).toBe(true);
      await waitFor(
        async () =>
          (await scalar(`
            SELECT count(*)::text
            FROM pg_stat_activity
            WHERE wait_event = 'PgSleep'
              AND query ILIKE '%wallet_ledger_entries%'
          `)) === '0',
        30_000,
      );
    } finally {
      if (api.process.exitCode === null) {
        api.process.kill('SIGKILL');
        await api.process.exited;
      }
      await cluster.database.orm.em
        .getConnection()
        .execute('DROP TRIGGER IF EXISTS test_pause_ledger_insert ON wallet_ledger_entries');
      await cluster.database.orm.em
        .getConnection()
        .execute('DROP FUNCTION IF EXISTS test_pause_ledger_insert()');
    }

    expect(await scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId])).toBe(
      '100.00',
    );
    expect(
      await scalar(
        `SELECT count(*)::text FROM wager_transactions WHERE wallet_id = ? AND external_transaction_id = ?`,
        [wallet.walletId, externalTransactionId],
      ),
    ).toBe('0');
    expect(
      await scalar(`SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ?`, [
        wallet.walletId,
      ]),
    ).toBe('1');
    expect(
      await scalar(`SELECT count(*)::text FROM outbox_messages WHERE payload::text LIKE ?`, [
        `%${externalTransactionId}%`,
      ]),
    ).toBe('0');

    const retryApi = await cluster.startApi('http-retry-after-kill');
    const retry = await fetch(`${retryApi}/wagering/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
    expect(retry.status).toBe(201);
    expect(await scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId])).toBe(
      '75.00',
    );
    expect(
      await scalar(
        `SELECT count(*)::text FROM wager_transactions WHERE wallet_id = ? AND external_transaction_id = ? AND status = 'PROCESSED'`,
        [wallet.walletId, externalTransactionId],
      ),
    ).toBe('1');
    expect(
      await scalar(`SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ?`, [
        wallet.walletId,
      ]),
    ).toBe('2');
  }, 120_000);
});

describe('an HTTP process killed after commit, before response', () => {
  test('a retry returns the committed result without applying it or emitting events twice', async () => {
    const wallet = await openWalletWith('100.00');
    const externalTransactionId = `http-post-commit-${randomUUID()}`;
    const providerKey = (
      await new CreateApiClient({
        repository: new MikroOrmApiClientRepository(cluster.database.orm),
        clock: () => NOW,
        newId: randomUUID,
      }).execute({
        name: 'crash-after-commit-provider',
        role: 'PROVIDER',
        providerId: 'provider-a',
      })
    ).apiKey;
    const apiUrl = await cluster.startApi(
      'http-killed-after-commit',
      'test/support/crashing-after-commit-api.ts',
    );
    const requestBody = {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const headers = {
      authorization: `Bearer ${providerKey}`,
      'content-type': 'application/json',
      'idempotency-key': `provider-a:${externalTransactionId}`,
    };
    const api = required(
      cluster.processes.find(({ name }) => name === 'http-killed-after-commit'),
      'the HTTP process under test',
    );

    const firstAttempt = await fetch(`${apiUrl}/wagering/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    }).then(
      (response) => ({ status: response.status }),
      (error: unknown) => ({ error }),
    );
    expect('error' in firstAttempt).toBe(true);
    expect(await exitOrTimeout(api, 5_000)).toBe(137);

    expect(await scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId])).toBe(
      '75.00',
    );
    expect(
      await scalar(
        `SELECT count(*)::text FROM wager_transactions WHERE wallet_id = ? AND external_transaction_id = ? AND status = 'PROCESSED'`,
        [wallet.walletId, externalTransactionId],
      ),
    ).toBe('1');
    expect(
      await scalar(`SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ?`, [
        wallet.walletId,
      ]),
    ).toBe('2');
    expect(
      await scalar(`SELECT count(*)::text FROM outbox_messages WHERE payload::text LIKE ?`, [
        `%${externalTransactionId}%`,
      ]),
    ).toBe('1');

    const retryApi = await cluster.startApi('http-retry-after-lost-response');
    const replay = await fetch(`${retryApi}/wagering/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: true,
      balance: { amount: '75.00' },
    });
    expect(
      await scalar(
        `SELECT count(*)::text FROM wager_transactions WHERE wallet_id = ? AND external_transaction_id = ? AND status = 'PROCESSED'`,
        [wallet.walletId, externalTransactionId],
      ),
    ).toBe('1');
    expect(
      await scalar(`SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ?`, [
        wallet.walletId,
      ]),
    ).toBe('2');
    expect(
      await scalar(`SELECT count(*)::text FROM outbox_messages WHERE payload::text LIKE ?`, [
        `%${externalTransactionId}%`,
      ]),
    ).toBe('1');
  }, 120_000);
});

describe('a worker stopped with SIGTERM during a batch', () => {
  test('finishes and acknowledges the batch in progress, and a restarted worker applies the rest exactly once', async () => {
    const wallet = await openWalletWith('500.00');
    const externalIds = Array.from({ length: 10 }, () => `batch-${randomUUID()}`);
    for (const externalTransactionId of externalIds) {
      await sendBet(wallet, externalTransactionId, '5.00');
    }
    const processedCount = () =>
      scalar(
        `SELECT count(*)::text FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`,
        [wallet.walletId],
      ).then(Number);

    const slow = cluster.startWorker('slow-worker', 'test/support/slow-worker.ts', {
      TRANSACTION_DELAY_MS: '300',
    });
    // The first transaction has committed, so the batch is in progress and the worker is running.
    await waitFor(async () => (await processedCount()) >= 1, 30_000);
    slow.process.kill('SIGTERM');

    expect(await exitOrTimeout(slow, 60_000)).toBe(0);
    // The batch in progress was finished and acknowledged: nothing from it is left in flight.
    expect(
      await new SqsQueue(testSqsClient(), cluster.queues.commandQueueUrl).countInFlight(),
    ).toBe(0);
    const processedAtExit = await processedCount();
    expect(processedAtExit).toBeGreaterThanOrEqual(1);

    const restarted = cluster.startWorker('restarted-after-shutdown', 'src/worker.ts', {
      CONSUMER_VISIBILITY_SECONDS: '2',
    });
    // A probe BET proves the restarted worker is running before it is stopped. Without it, a
    // SIGTERM sent while the process is still booting would end it before its handler exists.
    const probe = `batch-probe-${randomUUID()}`;
    await sendBet(wallet, probe, '5.00');
    await waitFor(async () => (await processedCount()) === externalIds.length + 1, 60_000);

    expect(await scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [wallet.walletId])).toBe(
      '445.00',
    );
    expect(
      await scalar(
        `SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [wallet.walletId],
      ),
    ).toBe(String(externalIds.length + 1));

    restarted.process.kill('SIGTERM');
    expect(await exitOrTimeout(restarted, 60_000)).toBe(0);
  }, 180_000);
});
