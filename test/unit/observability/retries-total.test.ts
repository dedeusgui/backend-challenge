import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money';
import type { MetricsSink } from '../../../src/shared/observability/metrics';
import { WagerCommandConsumer } from '../../../src/modules/messaging/application/inbound/wager-command-consumer';
import type {
  MessageQueue,
  ReceivedMessage,
} from '../../../src/modules/messaging/application/ports/message-queue';
import { OutboxPublisher } from '../../../src/modules/messaging/application/outbound/outbox-publisher';
import type { OutboxStore } from '../../../src/modules/messaging/application/ports/outbox-store';
import type { OutboxTransport } from '../../../src/modules/messaging/application/ports/outbox-transport';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { ProcessPendingReferences } from '../../../src/modules/wagering/application/process-pending-references.use-case';
import { WagerTransaction } from '../../../src/modules/wagering/domain/wager-transaction';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import type { FinancialRepositories } from '../../../src/shared/application/ports/financial-unit-of-work';

const now = new Date('2026-07-29T15:00:00.000Z');

class RecordingMetrics implements MetricsSink {
  readonly increments: Array<{ name: string; labels: Record<string, string> }> = [];

  increment(name: string, labels: Record<string, string> = {}): void {
    this.increments.push({ name, labels });
  }

  observe(): void {}
}

function retryIncrements(metrics: RecordingMetrics) {
  return metrics.increments.filter(({ name }) => name === 'retries_total');
}

describe('retries_total', () => {
  test('counts command requeues, failed outbox publishes, and pending reference lookups', async () => {
    const metrics = new RecordingMetrics();

    const message: ReceivedMessage = {
      receiptHandle: 'receipt',
      receiveCount: 1,
      body: JSON.stringify({
        messageId: 'message-1',
        type: 'WagerTransactionRequested',
        occurredAt: now.toISOString(),
        data: {
          providerId: 'provider-a',
          externalTransactionId: 'tx-1',
          idempotencyKey: 'key-1',
          playerId: '00000000-0000-4000-8000-000000000001',
          walletId: '00000000-0000-4000-8000-000000000002',
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        },
      }),
    };
    const queue: MessageQueue = {
      send: async () => undefined,
      receive: async () => [message],
      acknowledge: async () => undefined,
      changeVisibility: async () => undefined,
      extendVisibility: async () => undefined,
    };
    await new WagerCommandConsumer({
      consumerName: 'wager-transactions',
      queue,
      deadLetters: queue,
      process: {
        execute: async () => {
          throw new Error('temporary');
        },
      },
      visibilityTimeoutSeconds: 30,
      metrics,
    }).pollOnce();

    const event = OutboxMessage.rehydrate({
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WagerTransactionProcessed',
      payload: {
        eventId: 'event-1',
        eventType: 'WagerTransactionProcessed',
        aggregateId: 'wallet-1',
        correlationId: 'corr-1',
        occurredAt: now.toISOString(),
        version: 1,
        data: {},
      },
      occurredAt: now,
      attempts: 0,
      nextAttemptAt: now,
      publishedAt: undefined,
    });
    const store: OutboxStore = {
      claimDue: async () => [event],
      complete: async () => [],
      reschedule: async () => true,
    };
    const transport: OutboxTransport = {
      publish: async () => [{ id: 'event-1', error: new Error('temporary') }],
    };
    await new OutboxPublisher({
      store,
      transport,
      clock: () => now,
      newLeaseToken: () => 'lease',
      leaseDurationMs: 1_000,
      batchSize: 10,
      metrics,
    }).publishOnce();

    const held = WagerTransaction.rehydrate({
      id: 'tx-id',
      providerId: 'provider-a',
      externalTransactionId: 'tx-2',
      idempotencyKey: 'key-2',
      payloadHash: 'hash',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'REFUND',
      money: Money.from({ amount: '1.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'missing',
      createdAt: now,
      status: 'PENDING_REFERENCE',
      referenceTransactionId: undefined,
      failureCode: undefined,
      resultingBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
      processedAt: undefined,
      referenceAttempts: 0,
      referenceNextAttemptAt: new Date(now.getTime() - 1),
    });
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: Money.from({ amount: '10.00', currency: 'BRL' }),
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const wallets = { findForUpdate: async () => wallet };
    const repositories: FinancialRepositories = {
      wallets: {
        ...wallets,
        findById: async () => wallet,
        findForShare: async () => wallet,
        insert: async () => undefined,
        save: async () => undefined,
      },
      ledger: {
        append: async () => undefined,
        listByWallet: async () => [],
        listPageAfter: async () => [],
        summarize: async () => ({ calculated: Money.zero('BRL'), entries: 0, chainIntact: true }),
      },
      wagers: {
        insert: async () => undefined,
        update: async () => undefined,
        findDueForReferenceLookup: async () => [held],
        findById: async () => held,
        findByExternalId: async () => undefined,
        findByIdentity: async () => undefined,
        processedOutcomesOf: async () => ({ reversed: false, settled: false }),
      },
      inbox: { find: async () => undefined, insert: async () => undefined },
      outbox: { enqueue: async () => undefined },
      databaseClock: { now: async () => now },
    };
    const context = {
      unitOfWork: {
        run: async <T>(work: (repos: FinancialRepositories) => Promise<T>) => work(repositories),
      },
      clock: () => now,
      newId: () => 'new-id',
      metrics,
    };
    await new ProcessPendingReferences(context).runOnce();

    expect(retryIncrements(metrics)).toEqual([
      { name: 'retries_total', labels: { subsystem: 'command' } },
      { name: 'retries_total', labels: { subsystem: 'outbox' } },
      { name: 'retries_total', labels: { subsystem: 'reference' } },
    ]);
  });
});
