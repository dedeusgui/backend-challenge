import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { WorkerConfig } from '../config/worker-config';
import { OutboxPublisher } from '../modules/messaging/application/outbox-publisher';
import {
  NO_FAULTS,
  WagerCommandConsumer,
  type ConsumerFaults,
} from '../modules/messaging/application/wager-command-consumer';
import { MikroOrmOutboxStore } from '../modules/messaging/infrastructure/mikro-orm-outbox.store';
import { SqsEventTransport } from '../modules/messaging/infrastructure/sqs/sqs-event-transport';
import { SqsQueue } from '../modules/messaging/infrastructure/sqs/sqs-queue';
import { ProcessWagerTransaction } from '../modules/wagering/application/process-wager-transaction.use-case';
import { ProcessPendingReferences } from '../modules/wagering/application/process-pending-references.use-case';
import { MikroOrmFinancialUnitOfWork } from '../shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { ormOptions } from '../shared/infrastructure/database/orm-config';
import { createSqsClient, resolveQueues } from '../shared/infrastructure/sqs/sqs-connection';

export const WAGER_CONSUMER_NAME = 'wager-transactions';

export interface WorkerRuntime {
  consumer: WagerCommandConsumer;
  publisher: OutboxPublisher;
  pendingReferences: ProcessPendingReferences;
  idleDelayMs: number;
  close(): Promise<void>;
}

export interface WorkerRuntimeOptions {
  /** Test-only seam. Production never passes it. */
  faults?: ConsumerFaults;
}

/**
 * Builds the worker's collaborators. The same use case that HTTP uses is wired into
 * the consumer. The publisher writes to the events queue and records outcomes under lease.
 */
export async function createWorkerRuntime(
  config: WorkerConfig,
  options: WorkerRuntimeOptions = {},
): Promise<WorkerRuntime> {
  const orm = await MikroORM.init(ormOptions(config.databaseUrl));
  const sqs = createSqsClient(config.sqs);
  const queues = await resolveQueues(sqs, config.sqs);
  const context = {
    unitOfWork: new MikroOrmFinancialUnitOfWork(orm),
    clock: () => new Date(),
    newId: randomUUID,
  };

  const consumer = new WagerCommandConsumer({
    consumerName: WAGER_CONSUMER_NAME,
    queue: new SqsQueue(sqs, queues.commandQueueUrl),
    deadLetters: new SqsQueue(sqs, queues.deadLetterQueueUrl),
    process: new ProcessWagerTransaction(context),
    visibilityTimeoutSeconds: config.consumerVisibilitySeconds,
    faults: options.faults ?? NO_FAULTS,
  });
  const publisher = new OutboxPublisher({
    store: new MikroOrmOutboxStore(orm),
    transport: new SqsEventTransport(new SqsQueue(sqs, queues.eventsQueueUrl)),
    clock: context.clock,
    newLeaseToken: randomUUID,
    leaseDurationMs: config.outboxLeaseMs,
    batchSize: config.outboxBatchSize,
  });

  return {
    consumer,
    publisher,
    pendingReferences: new ProcessPendingReferences(context),
    idleDelayMs: config.outboxIdleDelayMs,
    async close() {
      await orm.close(true);
      sqs.destroy();
    },
  };
}
