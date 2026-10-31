import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { OpenWallet } from '../../src/modules/wallet/application/open-wallet.use-case';
import { Money } from '../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { ProcessCluster, type ManagedProcess } from './support/process-cluster';

/**
 * The worker's counters are read while the real worker process runs. Nothing waits for the shutdown
 * line: the test reads the HTTP surface of a live worker that has published committed events, and only
 * then stops it.
 */

const NOW = new Date('2026-07-29T15:00:00.000Z');

let cluster: ProcessCluster;

beforeAll(async () => {
  cluster = await ProcessCluster.create();
}, 120_000);

afterAll(async () => {
  await cluster.close();
}, 60_000);

/** A port the kernel reports as free now. The worker binds it a moment later. */
function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

async function until<T>(
  description: string,
  managed: ManagedProcess,
  read: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (managed.process.exitCode !== null) {
      throw new Error(`${managed.name} exited before ${description}:\n${managed.recentOutput()}`);
    }
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `${description} did not happen within ${timeoutMs} ms:\n${managed.recentOutput()}`,
  );
}

describe('worker metrics while the worker runs', () => {
  test('a running worker reports what it published, through its own surface, before it stops', async () => {
    const unitOfWork = new MikroOrmFinancialUnitOfWork(cluster.database.orm);
    const openWallet = new OpenWallet({ unitOfWork, clock: () => NOW, newId: randomUUID });
    const walletId = (
      await openWallet.execute({
        playerId: randomUUID(),
        initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
      })
    ).walletId;
    expect(walletId).toMatch(/^[0-9a-f-]{36}$/);

    const port = freePort();
    const worker = cluster.startWorker('worker', 'src/worker.ts', {
      WORKER_HTTP_PORT: String(port),
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    await until('the surface answers', worker, async () => {
      const response = await fetch(`${baseUrl}/health/live`);
      return response.status === 200 ? true : undefined;
    });
    const metrics = await until('the first event is counted', worker, async () => {
      const body = (await (await fetch(`${baseUrl}/metrics`)).json()) as {
        counters: Record<string, number>;
      };
      return (body.counters.outbox_published_total ?? 0) >= 1 ? body : undefined;
    });

    // The process is still running when the counters are read: this is a live read, not the shutdown line.
    expect(worker.process.exitCode).toBeNull();
    expect(metrics.counters.outbox_published_total).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(metrics)).not.toContain(walletId);

    worker.process.kill('SIGTERM');
    expect(await worker.process.exited).toBe(0);
  }, 90_000);
});
