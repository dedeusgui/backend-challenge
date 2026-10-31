import { describe, expect, test } from 'bun:test';
import { OutboxMessage } from '../../../../src/modules/messaging/domain/outbox-message';
import {
  OutboxPublisher,
  type OutboxTransport,
  type OutboxTransportMessage,
} from '../../../../src/modules/messaging/application/outbox-publisher';
import type { OutboxStore } from '../../../../src/modules/messaging/application/outbox-store.port';

const NOW = new Date('2026-07-29T15:00:00.000Z');

function pendingEvent(id: string): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId: 'wallet-1',
    eventType: 'WagerTransactionProcessed',
    payload: {
      eventId: id,
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      occurredAt: NOW.toISOString(),
      version: 1,
      data: {},
    },
    occurredAt: NOW,
    attempts: 0,
    nextAttemptAt: NOW,
    publishedAt: undefined,
  });
}

/** A store that hands out the given events once, and records what the publisher writes back. */
function storeWith(due: readonly OutboxMessage[]) {
  const completed: string[][] = [];
  const rescheduled: string[] = [];
  const store: OutboxStore = {
    claimDue: async () => [...due],
    complete: async (messages) => {
      completed.push(messages.map((message) => message.id));
      return messages.map((message) => message.id);
    },
    reschedule: async (message) => {
      rescheduled.push(message.id);
      return true;
    },
  };
  return { store, completed, rescheduled };
}

function publisherWith(store: OutboxStore, transport: OutboxTransport): OutboxPublisher {
  return new OutboxPublisher({
    store,
    transport,
    clock: () => NOW,
    newLeaseToken: () => 'lease-1',
    leaseDurationMs: 30_000,
    batchSize: 20,
  });
}

describe('OutboxPublisher: a batch with one refused event', () => {
  test('reschedules the refused event alone, and completes the others in one store call', async () => {
    const { store, completed, rescheduled } = storeWith([
      pendingEvent('e1'),
      pendingEvent('e2'),
      pendingEvent('e3'),
    ]);
    const transport: OutboxTransport = {
      publish: async (messages: readonly OutboxTransportMessage[]) =>
        messages
          .filter((message) => message.id === 'e2')
          .map((message) => ({ id: message.id, error: new Error('refused') })),
    };

    const published = await publisherWith(store, transport).publishOnce();

    expect(published).toBe(2);
    expect(completed).toEqual([['e1', 'e3']]);
    expect(rescheduled).toEqual(['e2']);
  });

  test('a transport that throws reschedules every event of the batch, and completes none', async () => {
    const { store, completed, rescheduled } = storeWith([pendingEvent('e1'), pendingEvent('e2')]);
    const transport: OutboxTransport = {
      publish: async () => {
        throw new Error('the broker is unavailable');
      },
    };

    const published = await publisherWith(store, transport).publishOnce();

    expect(published).toBe(0);
    expect(completed).toEqual([]);
    expect(rescheduled).toEqual(['e1', 'e2']);
  });
});
