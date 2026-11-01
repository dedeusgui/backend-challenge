import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../../../src/shared/domain/domain-error';
import { Money } from '../../../../src/shared/domain/money';
import { RequestValidationError } from '../../../../src/shared/validation/request-validation';
import {
  IdempotencyConflictError,
  MessagePayloadConflictError,
  WalletNotFoundError,
} from '../../../../src/shared/application/application-errors';
import { classifyCommandFailure } from '../../../../src/shared/application/failure-classification';
import { parseWagerCommandMessage } from '../../../../src/modules/messaging/application/wager-command-message';
import { WagerTransactionFailed } from '../../../../src/modules/wagering/domain/events/wager-transaction-failed.event';
import { WagerTransactionPendingReference } from '../../../../src/modules/wagering/domain/events/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '../../../../src/modules/wagering/domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../../../src/modules/wagering/domain/events/wager-transaction-rejected.event';
import {
  WagerTransaction,
  type WagerTransactionState,
} from '../../../../src/modules/wagering/domain/wager-transaction';
import type { WagerTransactionKind } from '../../../../src/modules/wagering/domain/wager-transaction-kind';

const CONTEXT = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  occurredAt: new Date('2026-07-29T15:00:00.000Z'),
};
const MONEY = Money.from({ amount: '25.00', currency: 'BRL' });

function state(
  overrides: Partial<WagerTransactionState> & Pick<WagerTransactionState, 'status' | 'kind'>,
): WagerTransactionState {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-1',
    idempotencyKey: 'provider-a:transaction-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    money: MONEY,
    referenceExternalTransactionId: overrides.kind === 'BET' ? undefined : 'transaction-0',
    createdAt: CONTEXT.occurredAt,
    referenceTransactionId: undefined,
    failureCode: undefined,
    resultingBalance: MONEY,
    processedAt: undefined,
    referenceAttempts: 0,
    referenceNextAttemptAt: undefined,
    ...overrides,
  };
}

function transaction(
  overrides: Partial<WagerTransactionState> & Pick<WagerTransactionState, 'status' | 'kind'>,
): WagerTransaction {
  return WagerTransaction.rehydrate(state(overrides));
}

function refusalOf(action: () => unknown): string {
  try {
    action();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof DomainError ? error.code : `UNEXPECTED ${String(error)}`;
  }
}

describe('the integration events announce only the status they describe', () => {
  test('a processed transaction is announced, with its transaction id as the aggregate', () => {
    const event = WagerTransactionProcessed.from(
      transaction({ status: 'PROCESSED', kind: 'BET', processedAt: CONTEXT.occurredAt }),
      CONTEXT,
    );
    expect({ type: event.eventType, aggregate: event.aggregateId }).toEqual({
      type: 'WagerTransactionProcessed',
      aggregate: 'tx-1',
    });
  });

  test('a processed event refuses a transaction in any other status, and one with no balance', () => {
    expect(
      refusalOf(() =>
        WagerTransactionProcessed.from(
          transaction({ status: 'REJECTED', kind: 'BET', failureCode: 'INSUFFICIENT_BALANCE' }),
          CONTEXT,
        ),
      ),
    ).toBe('INVALID_TRANSACTION');
    expect(
      refusalOf(() =>
        WagerTransactionProcessed.from(
          transaction({
            status: 'PROCESSED',
            kind: 'BET',
            resultingBalance: undefined,
            processedAt: CONTEXT.occurredAt,
          }),
          CONTEXT,
        ),
      ),
    ).toBe('INVALID_TRANSACTION');
  });

  test('a rejected transaction is announced with its code, and refuses one that has no code', () => {
    const event = WagerTransactionRejected.from(
      transaction({ status: 'REJECTED', kind: 'BET', failureCode: 'INSUFFICIENT_BALANCE' }),
      CONTEXT,
    );
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(
      refusalOf(() =>
        WagerTransactionRejected.from(
          transaction({ status: 'PROCESSED', kind: 'BET', processedAt: CONTEXT.occurredAt }),
          CONTEXT,
        ),
      ),
    ).toBe('INVALID_TRANSACTION');
  });

  test('a pending transaction is announced only while it awaits a named reference', () => {
    const event = WagerTransactionPendingReference.from(
      transaction({
        status: 'PENDING_REFERENCE',
        kind: 'REFUND',
        referenceNextAttemptAt: CONTEXT.occurredAt,
      }),
      CONTEXT,
    );
    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(
      refusalOf(() =>
        WagerTransactionPendingReference.from(
          transaction({
            status: 'PENDING_REFERENCE',
            kind: 'BET',
            referenceNextAttemptAt: CONTEXT.occurredAt,
          }),
          CONTEXT,
        ),
      ),
    ).toBe('INVALID_TRANSACTION');
  });
});

describe('a failed transaction is announced only as failed', () => {
  test('a held transaction that failed permanently is announced with its code, and refuses one that did not fail', () => {
    const event = WagerTransactionFailed.from(
      transaction({
        status: 'FAILED',
        kind: 'REFUND',
        failureCode: 'PROCESSING_FAILED',
        processedAt: undefined,
      }),
      CONTEXT,
    );
    expect({ type: event.eventType, aggregate: event.aggregateId }).toEqual({
      type: 'WagerTransactionFailed',
      aggregate: 'tx-1',
    });
    expect(
      refusalOf(() =>
        WagerTransactionFailed.from(
          transaction({ status: 'REJECTED', kind: 'BET', failureCode: 'INSUFFICIENT_BALANCE' }),
          CONTEXT,
        ),
      ),
    ).toBe('INVALID_TRANSACTION');
  });
});

describe('a failure is classified as permanent or transient, by what it says about the message', () => {
  test('a request that is invalid, a payload that conflicts, and a wallet that does not exist are permanent', () => {
    for (const error of [
      new RequestValidationError('bad'),
      new IdempotencyConflictError('key reused'),
      new MessagePayloadConflictError('msg-1'),
      new WalletNotFoundError('wallet-1'),
      new DomainError('INVALID_MONEY', 'bad money'),
      new DomainError('CURRENCY_MISMATCH', 'mixed'),
      new DomainError('INVALID_WALLET', 'bad wallet'),
      new DomainError('INVALID_TRANSACTION', 'bad transaction'),
    ]) {
      expect(classifyCommandFailure(error)).toBe('PERMANENT');
    }
  });

  test('a domain failure outside the permanent list, and anything unknown, is transient: it may succeed later', () => {
    expect(
      classifyCommandFailure(
        new DomainError('INVALID_LEDGER_ENTRY', 'a ledger row that failed its check'),
      ),
    ).toBe('TRANSIENT');
    expect(classifyCommandFailure(new Error('the database is down'))).toBe('TRANSIENT');
  });
});

describe('a queue message names the operation it carries', () => {
  test('a message of another type is refused as invalid, and therefore goes to the dead-letter queue', () => {
    const body = JSON.stringify({
      messageId: 'm-1',
      type: 'SomethingElse',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: {},
    });
    expect(() => parseWagerCommandMessage(body, 'wager-transactions')).toThrow(
      RequestValidationError,
    );
  });
});

describe('the direction of a rollback follows the operation it reverses', () => {
  test('a rollback with no reference has no direction to take', () => {
    const rollback = transaction({ status: 'PENDING', kind: 'ROLLBACK' });
    expect(refusalOf(() => rollback.ledgerDirectionFor(undefined))).toBe('INVALID_TRANSACTION');
  });

  test('a rollback of a loss has no balance to move, and a rollback of a rollback cannot be applied', () => {
    const rollback = transaction({ status: 'PENDING', kind: 'ROLLBACK' });
    const loss = transaction({
      status: 'PROCESSED',
      kind: 'LOSS',
      processedAt: CONTEXT.occurredAt,
      id: 'loss-1',
    });
    const reversal = transaction({
      status: 'PROCESSED',
      kind: 'ROLLBACK',
      processedAt: CONTEXT.occurredAt,
      id: 'rb-1',
    });
    expect(refusalOf(() => rollback.ledgerDirectionFor(loss))).toBe('INVALID_TRANSACTION');
    expect(refusalOf(() => rollback.ledgerDirectionFor(reversal))).toBe('INVALID_TRANSACTION');
  });

  test('a rollback of a debit credits, and a rollback of a credit debits', () => {
    const rollback = transaction({ status: 'PENDING', kind: 'ROLLBACK' });
    const bet = transaction({
      status: 'PROCESSED',
      kind: 'BET' as WagerTransactionKind,
      processedAt: CONTEXT.occurredAt,
    });
    const win = transaction({
      status: 'PROCESSED',
      kind: 'WIN',
      processedAt: CONTEXT.occurredAt,
      id: 'win-1',
    });
    expect(rollback.ledgerDirectionFor(bet)).toBe('CREDIT');
    expect(rollback.ledgerDirectionFor(win)).toBe('DEBIT');
  });

  test('a kind with no ledger effect has no direction at all', () => {
    expect(
      refusalOf(() =>
        transaction({ status: 'PENDING', kind: 'LOSS' }).ledgerDirectionFor(undefined),
      ),
    ).toBe('INVALID_TRANSACTION');
  });
});

describe('the reading accessors report what was persisted', () => {
  test('the reference attempts and the next lookup are read back as stored', () => {
    const next = new Date('2026-07-29T15:01:00.000Z');
    const held = transaction({
      status: 'PENDING_REFERENCE',
      kind: 'REFUND',
      referenceAttempts: 2,
      referenceNextAttemptAt: next,
    });
    expect({ attempts: held.referenceAttempts, next: held.referenceNextAttemptAt }).toEqual({
      attempts: 2,
      next,
    });
  });

  test('a reference that the rules do not cover is ready, which is what a BET with no reference rule gets', () => {
    const bet = transaction({
      status: 'PENDING',
      kind: 'BET',
      referenceExternalTransactionId: 'transaction-0',
    });
    const reference = transaction({
      status: 'PROCESSED',
      kind: 'BET',
      processedAt: CONTEXT.occurredAt,
      id: 'ref-1',
    });
    expect(bet.evaluateReference(reference)).toEqual({ outcome: 'READY' });
  });
});
