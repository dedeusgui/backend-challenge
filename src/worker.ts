import { readWorkerConfig } from './config/worker-config';
import { runWorker, StopSignal } from './worker/run-worker';
import { createWorkerRuntime } from './worker/worker-runtime';
import { STDOUT_LOGGER } from './shared/observability/structured-log';
import { startWorkerHttp } from './worker/worker-http';

async function main(): Promise<void> {
  const config = readWorkerConfig(process.env);
  const runtime = await createWorkerRuntime(config, { logger: STDOUT_LOGGER });
  const stop = new StopSignal();
  process.once('SIGTERM', () => stop.request());
  process.once('SIGINT', () => stop.request());

  // The surface is up before the loops start, so the counters can be read while the worker runs.
  const http =
    config.httpPort === undefined
      ? undefined
      : startWorkerHttp({
          port: config.httpPort,
          hostname: '0.0.0.0',
          metrics: runtime.metrics,
          startedAt: new Date(),
        });
  await runWorker(runtime, stop, { logger: STDOUT_LOGGER });
  http?.close();
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), type: 'metrics', ...runtime.metrics.snapshot() })}\n`,
  );
  await runtime.close();
}

main().catch((error: unknown) => {
  console.error('Worker failed', error);
  process.exitCode = 1;
});
