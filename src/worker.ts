import { readWorkerConfig } from './config/worker-config';
import { runWorker, StopSignal } from './worker/run-worker';
import { createWorkerRuntime } from './worker/worker-runtime';
import { STDOUT_LOGGER } from './shared/observability/structured-log';

async function main(): Promise<void> {
  const config = readWorkerConfig(process.env);
  const runtime = await createWorkerRuntime(config, { logger: STDOUT_LOGGER });
  const stop = new StopSignal();
  process.once('SIGTERM', () => stop.request());
  process.once('SIGINT', () => stop.request());

  await runWorker(runtime, stop, { logger: STDOUT_LOGGER });
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), type: 'metrics', ...runtime.metrics.snapshot() })}\n`,
  );
  await runtime.close();
}

main().catch((error: unknown) => {
  console.error('Worker failed', error);
  process.exitCode = 1;
});
