/**
 * Test-only worker entrypoint. It behaves like the production worker, except that the process
 * exits hard (code 137) inside a financial transaction: after the transaction has written its
 * rows, and before it commits. Production code never carries this hook.
 */
import { readWorkerConfig } from '../../src/config/worker-config';
import { STDOUT_LOGGER } from '../../src/shared/observability/structured-log';
import { runWorker, StopSignal } from '../../src/worker/run-worker';
import { createWorkerRuntime } from '../../src/worker/worker-runtime';

const config = readWorkerConfig(process.env);
const runtime = await createWorkerRuntime(config, {
  logger: STDOUT_LOGGER,
  decorateUnitOfWork: (unitOfWork) => ({
    run: (work) =>
      unitOfWork.run(async (repositories) => {
        const result = await work(repositories);
        process.exit(137);
        return result;
      }),
  }),
});
await runWorker(runtime, new StopSignal(), { logger: STDOUT_LOGGER });
