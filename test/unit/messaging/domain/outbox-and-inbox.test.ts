import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../../../src/shared/domain/domain-error';
import { Money } from '../../../../src/shared/domain/money';
import { IntegrationEvent } from '../../../../src/shared/domain/integration-event';
import { InboxMessage } from '../../../../src/modules/messaging/domain/inbox-message';
import {
  OutboxMessage,
  retryDelayMs,
} from '../../../../src/modules/messaging/domain/outbox-message';
import { WagerTransactionRejected } from '../../../../src/modules/wagering/domain/events/wager-transaction-rejected.event';
import { WagerTransaction } from '../../../../src/modules/wagering/domain/wager-transaction';

const NOW = new Date('2026-07-29T15:00:00.000Z');

function domainErrorCodeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.code : `UNEXPECTED: ${String(error)}`;
  }
  return 'NO_ERROR';
}

function rejectedEvent(): IntegrationEvent<unknown> {
  const transaction = WagerTransaction.create({
    id: 'tx-internal-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    createdAt: NOW,
  });
  transaction.reject({
    code: 'INSUFFICIENT_BALANCE',
    observedBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
  });
  return WagerTransactionRejected.from(transaction, {
    eventId: 'event-1',
    correlationId: 'corr-1',
    occurredAt: NOW,
  });
}

function pendingOutbox(): OutboxMessage {
  return OutboxMessage.enqueue(rejectedEvent());
}

describe('OutboxMessage.enqueue', () => {
  test('uses the event id as a stable outbox identity and keeps the serialized envelope', () => {
    const outbox = pendingOutbox();

    expect(outbox.id).toBe('event-1');
    expect(outbox.aggregateId).toBe('tx-internal-1');
    expect(outbox.eventType).toBe('WagerTransactionRejected');
    expect(outbox.payload).toEqual(rejectedEvent().toJSON());
    expect(outbox.attempts).toBe(0);
    expect(outbox.publishedAt).toBeUndefined();
  });
});

describe('OutboxMessage due and publication', () => {
  test('a new message is due immediately', () => {
    expect(pendingOutbox().isDue(NOW)).toBe(true);
  });

  test('a message whose next attempt is in the future is not due yet', () => {
    const pending = pendingOutbox();
    const outbox = OutboxMessage.rehydrate({
      id: pending.id,
      aggregateId: pending.aggregateId,
      eventType: pending.eventType,
      payload: pending.payload,
      occurredAt: pending.occurredAt,
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + 1_000),
      publishedAt: undefined,
    });

    expect(outbox.isDue(new Date(NOW.getTime() + 500))).toBe(false);
    expect(outbox.isDue(new Date(NOW.getTime() + 1_000))).toBe(true);
  });

  test('a published message is pending no more and never due again', () => {
    const outbox = pendingOutbox();

    outbox.markPublished(NOW);

    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date(NOW.getTime() + 10_000_000))).toBe(false);
    expect(outbox.publishedAt).toEqual(NOW);
  });

  test('publishing twice is a programming error', () => {
    const outbox = pendingOutbox();
    outbox.markPublished(NOW);

    expect(domainErrorCodeOf(() => outbox.markPublished(NOW))).toBe('INVALID_OUTBOX_TRANSITION');
  });

  test('a published message cannot be scheduled for another attempt', () => {
    const outbox = pendingOutbox();
    outbox.markPublished(NOW);

    expect(domainErrorCodeOf(() => outbox.recordFailedAttempt())).toBe('INVALID_OUTBOX_TRANSITION');
  });
});

describe('retryDelayMs', () => {
  test.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [6, 32_000],
    [7, 60_000],
    [20, 60_000],
  ])('after %i failed attempts waits %i ms (exponential, capped at 60 s)', (attempts, expected) => {
    expect(retryDelayMs(attempts)).toBe(expected);
  });
});

describe('OutboxMessage.recordFailedAttempt', () => {
  test('counts each failed send, and leaves the next attempt time to the database clock', () => {
    const outbox = pendingOutbox();
    const before = outbox.nextAttemptAt;

    outbox.recordFailedAttempt();
    outbox.recordFailedAttempt();

    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt).toEqual(before);
  });
});

describe('InboxMessage', () => {
  test('receive records the consumer, message id and payload hash before processing', () => {
    const inbox = InboxMessage.receive({
      consumerName: 'wager-transactions',
      messageId: 'msg-123',
      payloadHash: 'c'.repeat(64),
      receivedAt: NOW,
    });

    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.matchesPayload('c'.repeat(64))).toBe(true);
    expect(inbox.matchesPayload('d'.repeat(64))).toBe(false);
  });

  test('markProcessed records the time once, and a second call is a programming error', () => {
    const inbox = InboxMessage.receive({
      consumerName: 'wager-transactions',
      messageId: 'msg-123',
      payloadHash: 'c'.repeat(64),
      receivedAt: NOW,
    });

    inbox.markProcessed(NOW);

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(NOW);
    expect(domainErrorCodeOf(() => inbox.markProcessed(NOW))).toBe('INVALID_INBOX_TRANSITION');
  });
});
