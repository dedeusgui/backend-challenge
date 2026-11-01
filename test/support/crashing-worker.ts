/**
 * Test-only worker entrypoint. It behaves like the production worker, except that the process exits hard
 * (SIGKILL-like, code 137) right after a command commits and before its message is acknowledged. The crash
 * point is a wrapper composed here (test/support/worker-seams.ts); production code has no such hook.
 */
import { readWorkerConfig } from '../../src/config/worker-config';
import { runWorker, StopSignal } from '../../src/worker/run-worker';
import { assembleWorker, connectWorkerDependencies } from '../../src/worker/worker-runtime';
import { STDOUT_LOGGER } from '../../src/shared/observability/structured-log';
import { exitAtFirstAcknowledge } from './worker-seams';

const config = readWorkerConfig(process.env);
const dependencies = await connectWorkerDependencies(config);
const runtime = assembleWorker(
  { ...dependencies, commandQueue: exitAtFirstAcknowledge(dependencies.commandQueue) },
  config,
  { logger: STDOUT_LOGGER },
);
await runWorker(runtime, new StopSignal(), { logger: STDOUT_LOGGER });
