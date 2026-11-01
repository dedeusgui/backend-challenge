/**
 * Test-only worker entrypoint. It behaves like the production worker, except that the process exits hard
 * (code 137) inside a financial transaction: after the transaction has written its rows, and before it
 * commits. The crash point is a wrapper composed here (test/support/worker-seams.ts).
 */
import { readWorkerConfig } from '../../src/config/worker-config';
import { STDOUT_LOGGER } from '../../src/shared/observability/structured-log';
import { runWorker, StopSignal } from '../../src/worker/run-worker';
import { assembleWorker, connectWorkerDependencies } from '../../src/worker/worker-runtime';
import { exitBeforeCommit } from './worker-seams';

const config = readWorkerConfig(process.env);
const dependencies = await connectWorkerDependencies(config);
const runtime = assembleWorker(
  { ...dependencies, unitOfWork: exitBeforeCommit(dependencies.unitOfWork) },
  config,
  { logger: STDOUT_LOGGER },
);
await runWorker(runtime, new StopSignal(), { logger: STDOUT_LOGGER });
