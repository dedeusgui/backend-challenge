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
  await Promise.all([
    consumeUntilStopped(runtime, stop),
    publishUntilStopped(runtime, stop),
    resolveReferencesUntilStopped(runtime, stop),
  ]);
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

const REFERENCE_IDLE_DELAY_MS = 1_000;

async function resolveReferencesUntilStopped(
  runtime: WorkerRuntime,
  stop: StopSignal,
): Promise<void> {
  while (!stop.isRequested()) {
    const examined = await runtime.pendingReferences.runOnce();
    if (examined === 0) {
      await sleep(REFERENCE_IDLE_DELAY_MS);
    }
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
