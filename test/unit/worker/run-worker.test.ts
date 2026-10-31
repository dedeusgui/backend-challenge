import { describe, expect, test } from 'bun:test';
import { runWorker, StopSignal, type WorkerLoops } from '../../../src/worker/run-worker';
import type { OperationLog } from '../../../src/shared/observability/structured-log';

class NetworkingError extends Error {
  readonly code = 'ECONNRESET';
}

function networkFailure(): Error {
  return new NetworkingError('connection reset with a message body');
}

describe('runWorker', () => {
  test('a failing pass in any loop is logged, and that loop keeps running until the worker is stopped', async () => {
    const stop = new StopSignal();
    const logged: OperationLog[] = [];
    const passes = { consume: 0, publish: 0, resolve: 0 };
    const stopWhenEveryLoopRanTwice = () => {
      if (Object.values(passes).every((count) => count >= 2)) {
        stop.request();
      }
    };
    const loops: WorkerLoops = {
      consumer: {
        // A real poll waits on the network, so the loop yields. The stub does the same.
        pollOnce: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          passes.consume += 1;
          stopWhenEveryLoopRanTwice();
          if (passes.consume === 1) throw networkFailure();
        },
      },
      publisher: {
        publishOnce: async () => {
          passes.publish += 1;
          stopWhenEveryLoopRanTwice();
          if (passes.publish === 1) throw networkFailure();
          return 0;
        },
      },
      pendingReferences: {
        runOnce: async () => {
          passes.resolve += 1;
          stopWhenEveryLoopRanTwice();
          if (passes.resolve === 1) throw networkFailure();
          return 0;
        },
      },
      idleDelayMs: 1,
    };

    await runWorker(loops, stop, { logger: (entry) => logged.push(entry), errorDelayMs: 1 });

    // Each loop kept going after its failed first pass. The counts are lower bounds: the loops
    // stop at different moments.
    expect(passes.consume).toBeGreaterThanOrEqual(2);
    expect(passes.publish).toBeGreaterThanOrEqual(2);
    expect(passes.resolve).toBeGreaterThanOrEqual(2);
    expect(logged.map((entry) => entry.operation).sort()).toEqual([
      'worker.consume',
      'worker.publish',
      'worker.resolve_references',
    ]);
    for (const entry of logged) {
      expect(entry).toMatchObject({
        status: 'failed',
        errorName: 'NetworkingError',
        errorCode: 'ECONNRESET',
      });
    }
    expect(JSON.stringify(logged)).not.toContain('message body');
  });
});
