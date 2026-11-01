/**
 * Test-only wrappers around the worker's dependencies. A test process uses them to crash or delay the
 * worker at a precise point. They live here, not in production code: the production worker receives the
 * plain adapters, and these wrappers are composed only by the test entry points.
 */
import type { MessageQueue } from '../../src/modules/messaging/application/message-queue.port';
import type { FinancialUnitOfWork } from '../../src/shared/application/ports/financial-unit-of-work.port';

/** Hard exit (code 137, like SIGKILL) at the first acknowledgement, after the commit and before the broker hears of it. */
export function exitAtFirstAcknowledge(queue: MessageQueue): MessageQueue {
  return {
    ...delegate(queue),
    acknowledge: async () => {
      process.exit(137);
    },
  };
}

/** Hard exit inside a financial transaction: after its rows are written, before the commit. */
export function exitBeforeCommit(unitOfWork: FinancialUnitOfWork): FinancialUnitOfWork {
  return {
    run: (work) =>
      unitOfWork.run(async (repositories) => {
        const result = await work(repositories);
        process.exit(137);
        return result;
      }),
  };
}

/** Holds every financial transaction for `delayMs` before it starts, so a batch stays in progress. */
export function delayEachTransaction(
  unitOfWork: FinancialUnitOfWork,
  delayMs: number,
): FinancialUnitOfWork {
  return {
    run: (work) =>
      unitOfWork.run(async (repositories) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return work(repositories);
      }),
  };
}

/** Forwards every call. Spreading an instance would drop its methods, so each one is named. */
function delegate(queue: MessageQueue): MessageQueue {
  return {
    send: (body, groupId, deduplicationId) => queue.send(body, groupId, deduplicationId),
    receive: (options) => queue.receive(options),
    acknowledge: (receiptHandle) => queue.acknowledge(receiptHandle),
    changeVisibility: (receiptHandle, seconds) => queue.changeVisibility(receiptHandle, seconds),
    extendVisibility: (receiptHandles, seconds) => queue.extendVisibility(receiptHandles, seconds),
  };
}
