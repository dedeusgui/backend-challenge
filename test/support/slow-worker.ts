/**
 * Test-only worker entrypoint. It behaves like the production worker, except that every financial
 * transaction waits for TRANSACTION_DELAY_MS before it starts. That keeps a batch in progress long
 * enough for a test to send SIGTERM while the batch is being processed. Production code never
 * carries this hook.
 */
import { readWorkerConfig } from '../../src/config/worker-config';
import { STDOUT_LOGGER } from '../../src/shared/observability/structured-log';
import { runWorker, StopSignal } from '../../src/worker/run-worker';
import { createWorkerRuntime } from '../../src/worker/worker-runtime';

const delayMs = Number(process.env.TRANSACTION_DELAY_MS ?? '0');
const config = readWorkerConfig(process.env);
const runtime = await createWorkerRuntime(config, {
  logger: STDOUT_LOGGER,
  decorateUnitOfWork: (unitOfWork) => ({
    run: (work) =>
      unitOfWork.run(async (repositories) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return work(repositories);
      }),
  }),
});
const stop = new StopSignal();
process.once('SIGTERM', () => stop.request());
await runWorker(runtime, stop, { logger: STDOUT_LOGGER });
await runtime.close();
