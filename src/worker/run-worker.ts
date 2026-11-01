import { describeError, type OperationLogger } from '../shared/observability/structured-log';

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

/** The three passes the worker repeats. The runtime satisfies it; a test can supply a stub. */
export interface WorkerLoops {
  consumer: { pollOnce(isStopping?: () => boolean): Promise<unknown> };
  publisher: { publishOnce(): Promise<number>; cleanRetainedEvents?(): Promise<number> };
  pendingReferences: { runOnce(): Promise<number> };
  idleDelayMs: number;
}

export interface RunWorkerOptions {
  logger: OperationLogger;
  /** Pause after a failed pass, so a dependency that is down is not called in a tight loop. */
  errorDelayMs?: number;
}

const DEFAULT_ERROR_DELAY_MS = 1_000;
const REFERENCE_IDLE_DELAY_MS = 1_000;
const OUTBOX_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;

interface LoopContext {
  stop: StopSignal;
  logger: OperationLogger;
  errorDelayMs: number;
}

/**
 * Runs the consume, publish and reference loops until the stop signal is set. Each loop checks
 * the signal between passes, so a pass in progress is completed and acknowledged first. An
 * interrupted pass keeps its messages invisible, and they return after the visibility timeout.
 *
 * A failed pass is logged with its error name and code, and its loop waits and tries again. One
 * failing dependency does not end the worker, and the other loops keep running.
 */
export async function runWorker(
  loops: WorkerLoops,
  stop: StopSignal,
  options: RunWorkerOptions,
): Promise<void> {
  const context: LoopContext = {
    stop,
    logger: options.logger,
    errorDelayMs: options.errorDelayMs ?? DEFAULT_ERROR_DELAY_MS,
  };
  await Promise.all([
    consumeUntilStopped(loops, context),
    publishUntilStopped(loops, context),
    resolveReferencesUntilStopped(loops, context),
  ]);
}

async function consumeUntilStopped(loops: WorkerLoops, context: LoopContext): Promise<void> {
  while (!context.stop.isRequested()) {
    await runPass(context, 'worker.consume', () =>
      loops.consumer.pollOnce(() => context.stop.isRequested()),
    );
  }
}

async function publishUntilStopped(loops: WorkerLoops, context: LoopContext): Promise<void> {
  let nextRetentionAt = Date.now() + OUTBOX_RETENTION_INTERVAL_MS;
  let retentionWork: Promise<void> | undefined;
  while (!context.stop.isRequested()) {
    const published = await runPass(context, 'worker.publish', () => loops.publisher.publishOnce());
    if (Date.now() >= nextRetentionAt && loops.publisher.cleanRetainedEvents !== undefined) {
      nextRetentionAt = Date.now() + OUTBOX_RETENTION_INTERVAL_MS;
      retentionWork = loops.publisher
        .cleanRetainedEvents()
        .then(() => undefined)
        .catch((error: unknown) => {
          context.logger({
            operation: 'worker.outbox_retention',
            status: 'failed',
            ...describeError(error),
          });
        });
    }
    if (!published) {
      await sleep(loops.idleDelayMs);
    }
  }
  await retentionWork;
}

async function resolveReferencesUntilStopped(
  loops: WorkerLoops,
  context: LoopContext,
): Promise<void> {
  while (!context.stop.isRequested()) {
    const examined = await runPass(context, 'worker.resolve_references', () =>
      loops.pendingReferences.runOnce(),
    );
    if (!examined) {
      await sleep(REFERENCE_IDLE_DELAY_MS);
    }
  }
}

/** Returns the result of the pass, or undefined when it failed. The failure never leaves the loop. */
async function runPass<T>(
  context: LoopContext,
  operation: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    context.logger({ operation, status: 'failed', ...describeError(error) });
    await sleep(context.errorDelayMs);
    return undefined;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
