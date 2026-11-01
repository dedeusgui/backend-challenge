import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { WorkerConfig } from '../config/worker-config';
import type { FinancialUnitOfWork } from '../shared/application/ports/financial-unit-of-work';
import { OutboxPublisher } from '../modules/messaging/application/outbound/outbox-publisher';
import type { MessageQueue } from '../modules/messaging/application/ports/message-queue';
import type { OutboxStore } from '../modules/messaging/application/ports/outbox-store';
import { WagerCommandConsumer } from '../modules/messaging/application/inbound/wager-command-consumer';
import { MikroOrmOutboxStore } from '../modules/messaging/infrastructure/mikro-orm-outbox.store';
import {
  SqsEventTransport,
  type EventBatchSender,
} from '../modules/messaging/infrastructure/sqs/sqs-event-transport';
import { SqsQueue } from '../modules/messaging/infrastructure/sqs/sqs-queue';
import { ProcessWagerTransaction } from '../modules/wagering/application/process-wager-transaction.use-case';
import { ProcessPendingReferences } from '../modules/wagering/application/process-pending-references.use-case';
import { MikroOrmFinancialUnitOfWork } from '../shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { ormOptions } from '../shared/infrastructure/database/orm-config';
import { createSqsClient, resolveQueues } from '../shared/infrastructure/sqs/sqs-connection';
import { MetricsRegistry } from '../shared/observability/metrics';
import type { OperationLogger } from '../shared/observability/structured-log';

export const WAGER_CONSUMER_NAME = 'wager-transactions';

export interface WorkerRuntime {
  metrics: MetricsRegistry;
  consumer: WagerCommandConsumer;
  publisher: OutboxPublisher;
  pendingReferences: ProcessPendingReferences;
  idleDelayMs: number;
  close(): Promise<void>;
}

export interface WorkerRuntimeOptions {
  logger?: OperationLogger;
  metrics?: MetricsRegistry;
}

/**
 * The external resources a worker uses. Production obtains them from `connectWorkerDependencies`. A test
 * that needs a crash or a delay at a precise point wraps one of them and passes the result to
 * `assembleWorker`, so that production code never carries a hook for that purpose.
 */
export interface WorkerDependencies {
  unitOfWork: FinancialUnitOfWork;
  outboxStore: OutboxStore;
  commandQueue: MessageQueue;
  deadLetters: MessageQueue;
  eventsQueue: EventBatchSender;
  close(): Promise<void>;
}

/** The tuning values the worker takes from its configuration. */
export type WorkerTuning = Pick<
  WorkerConfig,
  | 'consumerVisibilitySeconds'
  | 'outboxBatchSize'
  | 'outboxLeaseMs'
  | 'outboxIdleDelayMs'
  | 'outboxRetentionDays'
>;

/** Opens the database and the queues the worker uses, from its configuration. */
export async function connectWorkerDependencies(config: WorkerConfig): Promise<WorkerDependencies> {
  const orm = await MikroORM.init(ormOptions(config.databaseUrl));
  const sqs = createSqsClient(config.sqs);
  const queues = await resolveQueues(sqs, config.sqs);
  return {
    unitOfWork: new MikroOrmFinancialUnitOfWork(orm),
    outboxStore: new MikroOrmOutboxStore(orm),
    commandQueue: new SqsQueue(sqs, queues.commandQueueUrl),
    deadLetters: new SqsQueue(sqs, queues.deadLetterQueueUrl),
    eventsQueue: new SqsQueue(sqs, queues.eventsQueueUrl),
    async close() {
      await orm.close(true);
      sqs.destroy();
    },
  };
}

/**
 * Builds the worker's collaborators from the given dependencies. The same use case that HTTP uses is wired
 * into the consumer. The publisher writes to the events queue and records outcomes under lease.
 */
export function assembleWorker(
  dependencies: WorkerDependencies,
  tuning: WorkerTuning,
  options: WorkerRuntimeOptions = {},
): WorkerRuntime {
  const metrics = options.metrics ?? new MetricsRegistry();
  const context = {
    unitOfWork: dependencies.unitOfWork,
    clock: () => new Date(),
    newId: randomUUID,
    metrics,
  };

  const consumer = new WagerCommandConsumer({
    consumerName: WAGER_CONSUMER_NAME,
    queue: dependencies.commandQueue,
    deadLetters: dependencies.deadLetters,
    process: new ProcessWagerTransaction(context),
    visibilityTimeoutSeconds: tuning.consumerVisibilitySeconds,
    metrics,
    logger: options.logger,
  });
  const publisher = new OutboxPublisher({
    store: dependencies.outboxStore,
    transport: new SqsEventTransport(dependencies.eventsQueue),
    clock: context.clock,
    newLeaseToken: randomUUID,
    leaseDurationMs: tuning.outboxLeaseMs,
    batchSize: tuning.outboxBatchSize,
    retentionDays: tuning.outboxRetentionDays,
    metrics,
    logger: options.logger,
  });

  return {
    metrics,
    consumer,
    publisher,
    pendingReferences: new ProcessPendingReferences(context),
    idleDelayMs: tuning.outboxIdleDelayMs,
    close: () => dependencies.close(),
  };
}

/** The production entry point: connects to the configured database and queues, then assembles the worker. */
export async function createWorkerRuntime(
  config: WorkerConfig,
  options: WorkerRuntimeOptions = {},
): Promise<WorkerRuntime> {
  return assembleWorker(await connectWorkerDependencies(config), config, options);
}
