import { describe, expect, test } from 'bun:test';
import {
  SqsEventTransport,
  type EventBatchEntry,
  type EventBatchOutcome,
  type EventBatchSender,
} from '../../../../src/modules/messaging/infrastructure/sqs/sqs-event-transport';

/** A broker stand-in: it records each request and refuses the events it is told to refuse. */
function brokerWith(options: { refuse?: readonly string[]; failRequest?: number } = {}) {
  const requests: EventBatchEntry[][] = [];
  const sender: EventBatchSender = {
    sendBatch: async (entries): Promise<EventBatchOutcome> => {
      requests.push([...entries]);
      if (options.failRequest === requests.length) {
        throw new Error('the broker did not answer');
      }
      const refused = entries.filter((entry) => options.refuse?.includes(entry.id) === true);
      return {
        sentIds: entries.filter((entry) => !refused.includes(entry)).map((entry) => entry.id),
        refused: refused.map((entry) => ({
          id: entry.id,
          code: 'InternalError',
          message: 'refused',
        })),
      };
    },
  };
  return { sender, requests };
}

function eventsOf(count: number, aggregateId = 'wallet-1') {
  return Array.from({ length: count }, (_, index) => ({
    id: `event-${String(index).padStart(3, '0')}`,
    aggregateId,
    payload: { index },
  }));
}

describe('SqsEventTransport: batches', () => {
  test('sends at most ten events in one broker request, and keeps their order', async () => {
    const { sender, requests } = brokerWith();
    const messages = eventsOf(12);

    const failures = await new SqsEventTransport(sender).publish(messages);

    expect(failures).toEqual([]);
    expect(requests.map((request) => request.length)).toEqual([10, 2]);
    expect(requests.flat().map((entry) => entry.id)).toEqual(messages.map((message) => message.id));
  });

  test('an entry is the event body, in the aggregate group, with the event id as its deduplication id', async () => {
    const { sender, requests } = brokerWith();

    await new SqsEventTransport(sender).publish([
      { id: 'event-1', aggregateId: 'wallet-9', payload: { amount: '25.00' } },
    ]);

    expect(requests[0]).toEqual([
      {
        id: 'event-1',
        body: '{"amount":"25.00"}',
        groupId: 'wallet-9',
        deduplicationId: 'event-1',
      },
    ]);
  });

  test('an event the broker refuses is a failure, and the events it accepted are not', async () => {
    const { sender } = brokerWith({ refuse: ['event-002'] });

    const failures = await new SqsEventTransport(sender).publish(eventsOf(4));

    expect(failures.map((failure) => failure.id)).toEqual(['event-002']);
  });

  test('a request that fails is a failure of each event in it, and the next request is still sent', async () => {
    const { sender, requests } = brokerWith({ failRequest: 1 });
    const messages = eventsOf(12);

    const failures = await new SqsEventTransport(sender).publish(messages);

    expect(failures.map((failure) => failure.id)).toEqual(messages.slice(0, 10).map((m) => m.id));
    expect(requests).toHaveLength(2);
  });
});
