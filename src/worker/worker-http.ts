import type { MetricsRegistry } from '../shared/observability/metrics';

export interface WorkerHttpOptions {
  port: number;
  /** The interface to listen on. Compose publishes nothing from the worker, so this is the internal network. */
  hostname: string;
  metrics: Pick<MetricsRegistry, 'snapshot'>;
  startedAt: Date;
  now?: () => Date;
}

export interface WorkerHttpServer {
  readonly port: number;
  close(): void;
}

/**
 * The worker's own HTTP surface: liveness, and the metrics of this process while it runs. Without it, the
 * counters of a worker were visible only in the line it printed at shutdown, and not at all after a crash.
 *
 * It answers only GET and HEAD, and it carries counts and durations, never payloads or identifiers. A
 * consumer computes a rate from two reads: the difference of the counters over the difference of
 * `collectedAt`.
 */
export function startWorkerHttp(options: WorkerHttpOptions): WorkerHttpServer {
  const now = options.now ?? (() => new Date());
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    fetch(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json(
          405,
          { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET' } },
          { allow: 'GET, HEAD' },
        );
      }
      const { pathname } = new URL(request.url);
      if (pathname === '/health/live') {
        return json(200, { status: 'ok' });
      }
      if (pathname === '/metrics') {
        return json(200, {
          startedAt: options.startedAt.toISOString(),
          collectedAt: now().toISOString(),
          pid: process.pid,
          ...options.metrics.snapshot(),
        });
      }
      return json(404, { error: { code: 'NOT_FOUND', message: 'Unknown route' } });
    },
    error() {
      // The reason stays out of the response. The process logs its own failures.
      return json(500, { error: { code: 'INTERNAL_ERROR', message: 'Unexpected failure' } });
    },
  });
  const boundPort = server.port;
  if (boundPort === undefined) {
    server.stop(true);
    throw new Error('the worker HTTP surface did not bind a port');
  }
  return {
    port: boundPort,
    close() {
      server.stop(true);
    },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}
