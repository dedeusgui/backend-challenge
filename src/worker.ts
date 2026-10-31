import { readWorkerConfig } from './config/worker-config';
import { runWorker, StopSignal } from './worker/run-worker';
import { createWorkerRuntime } from './worker/worker-runtime';

async function main(): Promise<void> {
  const config = readWorkerConfig(process.env);
  const runtime = await createWorkerRuntime(config);
  const stop = new StopSignal();
  process.once('SIGTERM', () => stop.request());
  process.once('SIGINT', () => stop.request());

  await runWorker(runtime, stop);
  await runtime.close();
}

main().catch((error: unknown) => {
  console.error('Worker failed', error);
  process.exitCode = 1;
});
