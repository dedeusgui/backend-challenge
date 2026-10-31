import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/shared/domain/money';
import { Wallet } from '../../../../src/modules/wallet/domain/wallet';
import { WalletBalanceChanged } from '../../../../src/modules/wallet/domain/events/wallet-balance-changed.event';
import { WagerTransactionPendingReference } from '../../../../src/modules/wagering/domain/events/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '../../../../src/modules/wagering/domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../../../src/modules/wagering/domain/events/wager-transaction-rejected.event';
import { WagerTransaction } from '../../../../src/modules/wagering/domain/wager-transaction';

const OCCURRED_AT = new Date('2026-07-29T15:00:02.000Z');

function context(overrides: { causationId?: string } = {}) {
  return {
    eventId: 'event-1',
    correlationId: 'corr-1',
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function transactionOf(overrides: {
  id?: string;
  kind?: 'BET' | 'ROLLBACK';
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
}) {
  return WagerTransaction.create({
    id: overrides.id ?? 'tx-internal-1',
    providerId: 'provider-a',
    externalTransactionId: overrides.externalTransactionId ?? 'transaction-123',
    idempotencyKey: `provider-a:${overrides.externalTransactionId ?? 'transaction-123'}`,
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: overrides.kind ?? 'BET',
    money: brl('25.00'),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    createdAt: OCCURRED_AT,
  });
}

describe('IntegrationEvent envelope', () => {
  test('serializes identity, correlation, ISO time, version and event type', () => {
    const transaction = transactionOf({});
    transaction.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: brl('10.00') });

    const envelope = WagerTransactionRejected.from(transaction, context()).toJSON();

    expect(envelope).toMatchObject({
      eventId: 'event-1',
      eventType: 'WagerTransactionRejected',
      aggregateId: 'tx-internal-1',
      correlationId: 'corr-1',
      occurredAt: '2026-07-29T15:00:02.000Z',
      version: 1,
    });
  });

  test('omits causationId when it is not provided, instead of serializing null', () => {
    const transaction = transactionOf({});
    transaction.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: brl('10.00') });

    const envelope = WagerTransactionRejected.from(transaction, context()).toJSON();

    expect('causationId' in envelope).toBe(false);
  });

  test('keeps causationId when it is provided', () => {
    const transaction = transactionOf({});
    transaction.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: brl('10.00') });

    const envelope = WagerTransactionRejected.from(
      transaction,
      context({ causationId: 'msg-123' }),
    ).toJSON();

    expect(envelope.causationId).toBe('msg-123');
  });
});

describe('Concrete integration events', () => {
  test('WagerTransactionProcessed carries amounts as decimal strings', () => {
    const transaction = transactionOf({});
    transaction.markProcessed({
      referenceTransactionId: undefined,
      resultingBalance: brl('75.00'),
      at: OCCURRED_AT,
    });

    const envelope = WagerTransactionProcessed.from(transaction, context()).toJSON();

    expect(envelope.eventType).toBe('WagerTransactionProcessed');
    expect(envelope.data).toEqual({
      transactionId: 'tx-internal-1',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-987',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      resultingBalance: { amount: '75.00', currency: 'BRL' },
    });
  });

  test('WagerTransactionRejected carries the stable failure code and the observed balance', () => {
    const transaction = transactionOf({});
    transaction.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: brl('10.00') });

    const envelope = WagerTransactionRejected.from(transaction, context()).toJSON();

    expect(envelope.eventType).toBe('WagerTransactionRejected');
    expect(envelope.data).toMatchObject({
      transactionId: 'tx-internal-1',
      failureCode: 'INSUFFICIENT_BALANCE',
      observedBalance: { amount: '10.00', currency: 'BRL' },
    });
  });

  test('WagerTransactionPendingReference names the missing external reference', () => {
    const pending = transactionOf({
      id: 'tx-internal-2',
      externalTransactionId: 'transaction-200',
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'bet-missing',
    });
    pending.markPendingReference(new Date('2026-07-29T15:00:01.000Z'), brl('100.00'));

    const envelope = WagerTransactionPendingReference.from(pending, context()).toJSON();

    expect(envelope.eventType).toBe('WagerTransactionPendingReference');
    expect(envelope.data).toMatchObject({
      transactionId: 'tx-internal-2',
      referenceExternalTransactionId: 'bet-missing',
    });
  });

  test('WalletBalanceChanged carries the entry, both balances and the wallet version', () => {
    const { wallet } = Wallet.open({
      walletId: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      openingTransactionId: 'opening-tx',
      openingEntryId: 'opening-entry',
      openedAt: OCCURRED_AT,
    });
    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'tx-internal-1',
      money: brl('25.00'),
      at: OCCURRED_AT,
    });

    const envelope = WalletBalanceChanged.from(wallet, entry, context()).toJSON();

    expect(envelope.eventType).toBe('WalletBalanceChanged');
    expect(envelope.version).toBe(1);
    expect(envelope.data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-internal-1',
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });
});
