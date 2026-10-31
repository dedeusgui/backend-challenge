/**
 * Test-only worker entrypoint. It behaves like the production worker, except that the
 * process exits hard (SIGKILL-like, code 137) right after a command commits and before
 * its message is acknowledged. Production code never carries this hook.
 */
import { readWorkerConfig } from '../../src/config/worker-config';
import { runWorker, StopSignal } from '../../src/worker/run-worker';
import { createWorkerRuntime } from '../../src/worker/worker-runtime';

const config = readWorkerConfig(process.env);
const runtime = await createWorkerRuntime(config, {
  faults: {
    beforeAcknowledge: async () => {
      process.exit(137);
    },
  },
});
await runWorker(runtime, new StopSignal());
