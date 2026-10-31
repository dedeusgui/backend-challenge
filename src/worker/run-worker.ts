import type { WorkerRuntime } from './worker-runtime';

/** Set by SIGTERM or SIGINT. Loops finish the batch in progress and then return. */
export class StopSignal {
  private requested = false;

  request(): void {
    this.requested = true;
  }

  isRequested(): boolean {
    return this.requested;
  }
}

/**
 * Runs the consume and publish loops until the stop signal is set. Each loop checks
 * the signal between batches, so a batch in progress is completed and acknowledged
 * first. An interrupted batch keeps its messages invisible, and they return after the
 * visibility timeout.
 */
export async function runWorker(runtime: WorkerRuntime, stop: StopSignal): Promise<void> {
  await Promise.all([consumeUntilStopped(runtime, stop), publishUntilStopped(runtime, stop)]);
}

async function consumeUntilStopped(runtime: WorkerRuntime, stop: StopSignal): Promise<void> {
  while (!stop.isRequested()) {
    await runtime.consumer.pollOnce();
  }
}

async function publishUntilStopped(runtime: WorkerRuntime, stop: StopSignal): Promise<void> {
  while (!stop.isRequested()) {
    const published = await runtime.publisher.publishOnce();
    if (published === 0) {
      await sleep(runtime.idleDelayMs);
    }
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
