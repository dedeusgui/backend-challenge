/**
 * Test-only worker entrypoint. It behaves like the production worker, except that every financial
 * transaction waits for TRANSACTION_DELAY_MS before it starts. That keeps a batch in progress long enough
 * for a test to send SIGTERM while the batch is being processed. The delay is a wrapper composed here
 * (test/support/worker-seams.ts).
 */
import { readWorkerConfig } from '../../src/config/worker-config';
import { STDOUT_LOGGER } from '../../src/shared/observability/structured-log';
import { runWorker, StopSignal } from '../../src/worker/run-worker';
import { assembleWorker, connectWorkerDependencies } from '../../src/worker/worker-runtime';
import { delayEachTransaction } from './worker-seams';

const delayMs = Number(process.env.TRANSACTION_DELAY_MS ?? '0');
const config = readWorkerConfig(process.env);
const dependencies = await connectWorkerDependencies(config);
const runtime = assembleWorker(
  { ...dependencies, unitOfWork: delayEachTransaction(dependencies.unitOfWork, delayMs) },
  config,
  { logger: STDOUT_LOGGER },
);
const stop = new StopSignal();
process.once('SIGTERM', () => stop.request());
await runWorker(runtime, stop, { logger: STDOUT_LOGGER });
await runtime.close();
