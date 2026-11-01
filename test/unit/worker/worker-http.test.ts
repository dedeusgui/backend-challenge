import { afterEach, describe, expect, test } from 'bun:test';
import { MetricsRegistry } from '../../../src/shared/observability/metrics';
import { startWorkerHttp, type WorkerHttpServer } from '../../../src/worker/worker-http';

/**
 * The worker's own HTTP surface: liveness and the metrics of this process while it runs. It is started on
 * an ephemeral loopback port here. Compose gives the worker a port on the internal network only.
 */
describe('worker HTTP surface', () => {
  let server: WorkerHttpServer | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  function start(metrics = new MetricsRegistry()) {
    server = startWorkerHttp({
      port: 0,
      hostname: '127.0.0.1',
      metrics,
      startedAt: new Date('2026-07-29T15:00:00.000Z'),
    });
    return { baseUrl: `http://127.0.0.1:${server.port}`, metrics };
  }

  test('liveness answers 200 with no dependency', async () => {
    const { baseUrl } = start();

    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('metrics show what the process counted while it runs, not only at shutdown', async () => {
    const { baseUrl, metrics } = start();

    const before = (await (await fetch(`${baseUrl}/metrics`)).json()) as {
      counters: Record<string, number>;
    };
    metrics.increment('outbox_published_total');
    metrics.increment('outbox_published_total');
    metrics.observe('outbox_lag_seconds', 1.5);
    const after = (await (await fetch(`${baseUrl}/metrics`)).json()) as {
      counters: Record<string, number>;
      summaries: Record<string, { count: number; sum: number; max: number }>;
    };

    expect(before.counters.outbox_published_total).toBeUndefined();
    expect(after.counters.outbox_published_total).toBe(2);
    expect(after.summaries.outbox_lag_seconds).toEqual({ count: 1, sum: 1.5, max: 1.5 });
  });

  test('metrics carry the start time, the read time and the process id, so a rate can be computed', async () => {
    const { baseUrl } = start();

    const body = (await (await fetch(`${baseUrl}/metrics`)).json()) as Record<string, unknown>;

    expect(body.startedAt).toBe('2026-07-29T15:00:00.000Z');
    expect(typeof body.collectedAt).toBe('string');
    expect(Number.isNaN(Date.parse(String(body.collectedAt)))).toBe(false);
    expect(body.pid).toBe(process.pid);
  });

  test('an unknown route is 404, and a write is 405, with JSON bodies', async () => {
    const { baseUrl } = start();

    const unknown = await fetch(`${baseUrl}/wallets`);
    const write = await fetch(`${baseUrl}/metrics`, { method: 'POST', body: '{}' });

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(write.status).toBe(405);
    expect(write.headers.get('allow')).toBe('GET, HEAD');
    expect(await write.json()).toMatchObject({ error: { code: 'METHOD_NOT_ALLOWED' } });
  });

  test('responses are never cached', async () => {
    const { baseUrl } = start();

    const response = await fetch(`${baseUrl}/metrics`);

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  test('a failure inside the surface is a 500 with a generic body, and the reason stays out of the response', async () => {
    const failing = new MetricsRegistry();
    failing.snapshot = () => {
      throw new Error('internal detail that must not leak');
    };
    const { baseUrl } = start(failing);

    const reply = await fetch(`${baseUrl}/metrics`);
    const text = await reply.text();

    expect(reply.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected failure' },
    });
    expect(text).not.toContain('internal detail');
  });

  test('a HEAD request answers the same status as a GET, with no body', async () => {
    const { baseUrl } = start();
    const reply = await fetch(`${baseUrl}/health/live`, { method: 'HEAD' });
    expect(reply.status).toBe(200);
    expect(await reply.text()).toBe('');
  });
});
