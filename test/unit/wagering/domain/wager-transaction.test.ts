import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../../../src/shared/domain/domain-error';
import { Money } from '../../../../src/shared/domain/money';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
  type WagerTransactionStatus,
} from '../../../../src/modules/wagering/domain/wager-transaction';

const CREATED_AT = new Date('2026-07-29T15:00:00.000Z');
const PROCESSED_AT = new Date('2026-07-29T15:00:02.000Z');
const HASH = 'a'.repeat(64);

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function domainErrorCodeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.code : `UNEXPECTED: ${String(error)}`;
  }
  return 'NO_ERROR';
}

function props(
  overrides: Partial<CreateWagerTransactionProps> & Pick<CreateWagerTransactionProps, 'kind'>,
): CreateWagerTransactionProps {
  return {
    id: `internal-${overrides.externalTransactionId ?? 'transaction-123'}`,
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: HASH,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function bet(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create(props({ kind: 'BET', ...overrides }));
}

/** A BET that has already been applied with 75.00 left in the wallet. */
function processedBet(): WagerTransaction {
  const transaction = bet({ externalTransactionId: 'bet-1', money: brl('25.00') });
  transaction.markProcessed({
    referenceTransactionId: undefined,
    resultingBalance: brl('75.00'),
    at: PROCESSED_AT,
  });
  return transaction;
}

describe('WagerTransaction.create', () => {
  test('a BET is born PENDING with no reference and no result', () => {
    const transaction = bet();

    expect(transaction.status).toBe('PENDING');
    expect(transaction.kind).toBe('BET');
    expect(transaction.referenceExternalTransactionId).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.resultingBalance).toBeUndefined();
  });

  test.each([
    ['REFUND', undefined],
    ['ROLLBACK', undefined],
  ] as const)('%s requires referenceExternalTransactionId', (kind, reference) => {
    expect(
      domainErrorCodeOf(() =>
        WagerTransaction.create(props({ kind, referenceExternalTransactionId: reference })),
      ),
    ).toBe('INVALID_TRANSACTION');
  });

  test.each(['BET', 'LOSS', 'OPENING'] as const)('%s must not carry a reference', (kind) => {
    expect(
      domainErrorCodeOf(() =>
        WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'bet-1' })),
      ),
    ).toBe('INVALID_TRANSACTION');
  });

  test('a WIN may reference the BET it settles', () => {
    const win = WagerTransaction.create(
      props({ kind: 'WIN', referenceExternalTransactionId: 'bet-1' }),
    );
    expect(win.referenceExternalTransactionId).toBe('bet-1');
  });

  test.each(['BET', 'WIN', 'REFUND', 'ROLLBACK', 'OPENING'] as const)(
    '%s with a zero amount is rejected as an invalid transaction',
    (kind) => {
      const referenceExternalTransactionId =
        kind === 'REFUND' || kind === 'ROLLBACK' ? 'bet-1' : undefined;
      expect(
        domainErrorCodeOf(() =>
          WagerTransaction.create(
            props({ kind, money: brl('0.00'), referenceExternalTransactionId }),
          ),
        ),
      ).toBe('INVALID_TRANSACTION');
    },
  );

  test('LOSS accepts a zero amount because it does not move the balance', () => {
    const loss = WagerTransaction.create(props({ kind: 'LOSS', money: brl('0.00') }));
    expect(loss.affectsBalance()).toBe(false);
  });

  test('a negative amount is rejected even for LOSS', () => {
    const negative = brl('0.00').subtract(brl('1.00'));
    expect(
      domainErrorCodeOf(() => WagerTransaction.create(props({ kind: 'LOSS', money: negative }))),
    ).toBe('INVALID_TRANSACTION');
  });
});

describe('WagerTransaction kind rules', () => {
  test.each([
    ['OPENING', true, false, 'CREDIT'],
    ['BET', true, false, 'DEBIT'],
    ['WIN', true, false, 'CREDIT'],
    ['LOSS', false, false, undefined],
    ['REFUND', true, true, 'CREDIT'],
  ] as const)(
    '%s: affectsBalance=%s requiresReference=%s direction=%s',
    (kind, affectsBalance, requiresReference, direction) => {
      const referenceExternalTransactionId = requiresReference ? 'bet-1' : undefined;
      const transaction = WagerTransaction.create(props({ kind, referenceExternalTransactionId }));

      expect(transaction.affectsBalance()).toBe(affectsBalance);
      expect(transaction.requiresReference()).toBe(requiresReference);
      if (direction) {
        expect(transaction.ledgerDirectionFor(undefined)).toBe(direction);
      }
    },
  );

  test('ROLLBACK reverses the direction of the transaction it references', () => {
    const rollback = WagerTransaction.create(
      props({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }),
    );
    const winReference = WagerTransaction.rehydrate({
      ...stateOf(processedBet()),
      kind: 'WIN',
    });
    const refundReference = WagerTransaction.rehydrate({
      ...stateOf(processedBet()),
      kind: 'REFUND',
    });

    expect(rollback.ledgerDirectionFor(processedBet())).toBe('CREDIT');
    expect(rollback.ledgerDirectionFor(winReference)).toBe('DEBIT');
    expect(rollback.ledgerDirectionFor(refundReference)).toBe('DEBIT');
  });

  test('a transaction with no ledger effect has no ledger direction', () => {
    const loss = WagerTransaction.create(props({ kind: 'LOSS' }));
    expect(domainErrorCodeOf(() => loss.ledgerDirectionFor(undefined))).toBe('INVALID_TRANSACTION');
  });

  test('OPENING is internal and cannot be submitted externally', () => {
    expect(WagerTransaction.isExternallySubmittable('OPENING')).toBe(false);
    expect(WagerTransaction.isExternallySubmittable('BET')).toBe(true);
    expect(WagerTransaction.isExternallySubmittable('ROLLBACK')).toBe(true);
  });

  test('only REFUND and ROLLBACK are reversals', () => {
    expect(
      WagerTransaction.create(
        props({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }),
      ).isReversal(),
    ).toBe(true);
    expect(
      WagerTransaction.create(
        props({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }),
      ).isReversal(),
    ).toBe(true);
    expect(bet().isReversal()).toBe(false);
  });
});

describe('WagerTransaction transitions', () => {
  test('PENDING → PROCESSED records the resulting balance and time', () => {
    const transaction = bet();

    transaction.markProcessed({
      referenceTransactionId: undefined,
      resultingBalance: brl('75.00'),
      at: PROCESSED_AT,
    });

    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.processedAt).toEqual(PROCESSED_AT);
    expect(transaction.resultingBalance?.toString()).toBe('75.00');
    expect(transaction.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED keeps the failure code and the observed balance', () => {
    const transaction = bet();

    transaction.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: brl('10.00') });

    expect(transaction.status).toBe('REJECTED');
    expect(transaction.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(transaction.resultingBalance?.toString()).toBe('10.00');
    expect(transaction.isTerminal()).toBe(true);
  });

  test('PENDING → PENDING_REFERENCE → PROCESSED for an out-of-order reversal', () => {
    const rollback = WagerTransaction.create(
      props({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('25.00') }),
    );

    rollback.markPendingReference(new Date('2026-07-29T15:00:01.000Z'));
    expect(rollback.status).toBe('PENDING_REFERENCE');

    rollback.markProcessed({
      referenceTransactionId: 'internal-bet-1',
      resultingBalance: brl('100.00'),
      at: PROCESSED_AT,
    });
    expect(rollback.status).toBe('PROCESSED');
    expect(rollback.referenceTransactionId).toBe('internal-bet-1');
  });

  test('PENDING_REFERENCE can be exhausted into a REJECTED terminal state', () => {
    const rollback = WagerTransaction.create(
      props({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }),
    );
    rollback.markPendingReference(new Date('2026-07-29T15:00:01.000Z'));

    rollback.reject({ code: 'REFERENCE_NOT_FOUND', observedBalance: brl('100.00') });

    expect(rollback.status).toBe('REJECTED');
    expect(rollback.failureCode).toBe('REFERENCE_NOT_FOUND');
  });

  test('a REFUND cannot be marked processed without its reference', () => {
    const refund = WagerTransaction.create(
      props({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }),
    );

    expect(
      domainErrorCodeOf(() =>
        refund.markProcessed({
          referenceTransactionId: undefined,
          resultingBalance: brl('100.00'),
          at: PROCESSED_AT,
        }),
      ),
    ).toBe('INVALID_TRANSACTION');
  });

  test('markPendingReference is only valid from PENDING', () => {
    const transaction = bet();
    transaction.markPendingReference(new Date('2026-07-29T15:00:01.000Z'));

    expect(
      domainErrorCodeOf(() =>
        transaction.markPendingReference(new Date('2026-07-29T15:00:01.000Z')),
      ),
    ).toBe('INVALID_TRANSACTION_TRANSITION');
  });
});

describe('WagerTransaction terminal states', () => {
  const terminalFactories: Array<[WagerTransactionStatus, () => WagerTransaction]> = [
    ['PROCESSED', processedBet],
    [
      'REJECTED',
      () => {
        const transaction = bet();
        transaction.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: brl('0.00') });
        return transaction;
      },
    ],
    [
      'FAILED',
      () => {
        const transaction = bet();
        transaction.fail({ code: 'PROCESSING_FAILED', observedBalance: undefined });
        return transaction;
      },
    ],
  ];

  test.each(terminalFactories)('%s rejects every further transition', (status, build) => {
    const transaction = build();
    expect(transaction.status).toBe(status);

    const attempts: Array<() => unknown> = [
      () => transaction.markPendingReference(new Date('2026-07-29T15:00:01.000Z')),
      () =>
        transaction.markProcessed({
          referenceTransactionId: undefined,
          resultingBalance: brl('1.00'),
          at: PROCESSED_AT,
        }),
      () => transaction.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: brl('1.00') }),
      () => transaction.fail({ code: 'PROCESSING_FAILED', observedBalance: undefined }),
    ];
    for (const attempt of attempts) {
      expect(domainErrorCodeOf(attempt)).toBe('INVALID_TRANSACTION_TRANSITION');
    }
    expect(transaction.status).toBe(status);
  });
});

describe('WagerTransaction wallet compatibility', () => {
  test('a transaction from the wallet owner in the wallet currency has no mismatch', () => {
    expect(bet().walletMismatch({ playerId: 'player-1', currency: 'BRL' })).toBeUndefined();
  });

  test('a wallet owned by another player is a player mismatch', () => {
    expect(bet().walletMismatch({ playerId: 'player-2', currency: 'BRL' })).toBe(
      'WALLET_PLAYER_MISMATCH',
    );
  });

  test('a wallet in another currency is a currency mismatch', () => {
    expect(bet().walletMismatch({ playerId: 'player-1', currency: 'USD' })).toBe(
      'WALLET_CURRENCY_MISMATCH',
    );
  });
});

describe('WagerTransaction reference evaluation', () => {
  test('a REFUND whose BET is still missing waits', () => {
    const refund = WagerTransaction.create(
      props({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }),
    );

    expect(refund.evaluateReference(undefined)).toEqual({ outcome: 'WAIT' });
  });

  test('a reference that is itself still pending makes the dependent transaction wait', () => {
    const rollback = WagerTransaction.create(
      props({ kind: 'ROLLBACK', referenceExternalTransactionId: 'win-1' }),
    );
    const pendingWin = WagerTransaction.rehydrate({
      ...stateOf(processedBet()),
      kind: 'WIN',
      status: 'PENDING_REFERENCE',
    });

    expect(rollback.evaluateReference(pendingWin)).toEqual({ outcome: 'WAIT' });
  });

  test('a reference that was rejected cannot be reversed', () => {
    const refund = WagerTransaction.create(
      props({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }),
    );
    const rejectedBet = bet({ externalTransactionId: 'bet-1' });
    rejectedBet.reject({ code: 'INSUFFICIENT_BALANCE', observedBalance: brl('0.00') });

    expect(refund.evaluateReference(rejectedBet)).toEqual({
      outcome: 'REJECT',
      code: 'REFERENCE_NOT_PROCESSED',
    });
  });

  test('a processed BET in the same context and amount is ready', () => {
    const refund = WagerTransaction.create(
      props({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1', money: brl('25.00') }),
    );

    expect(refund.evaluateReference(processedBet())).toEqual({ outcome: 'READY' });
  });

  test.each([
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['round', { roundId: 'round-other' }],
    ['provider', { providerId: 'provider-b' }],
  ] as const)('a reference from a different %s is a context mismatch', (_label, override) => {
    const refund = WagerTransaction.create(
      props({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1', money: brl('25.00') }),
    );
    const otherContext = WagerTransaction.rehydrate({
      ...stateOf(processedBet()),
      ...override,
    });

    expect(refund.evaluateReference(otherContext)).toEqual({
      outcome: 'REJECT',
      code: 'REFERENCE_CONTEXT_MISMATCH',
    });
  });

  test('a REFUND may only reference a BET', () => {
    const refund = WagerTransaction.create(
      props({ kind: 'REFUND', referenceExternalTransactionId: 'win-1', money: brl('25.00') }),
    );
    const processedWin = WagerTransaction.rehydrate({
      ...stateOf(processedBet()),
      kind: 'WIN',
    });

    expect(refund.evaluateReference(processedWin)).toEqual({
      outcome: 'REJECT',
      code: 'REFERENCE_KIND_NOT_ALLOWED',
    });
  });

  test('a reversal must match the referenced amount exactly', () => {
    const refund = WagerTransaction.create(
      props({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1', money: brl('24.99') }),
    );

    expect(refund.evaluateReference(processedBet())).toEqual({
      outcome: 'REJECT',
      code: 'REFERENCE_AMOUNT_MISMATCH',
    });
  });

  test('a WIN referencing a BET is not bound to the BET amount', () => {
    const win = WagerTransaction.create(
      props({ kind: 'WIN', referenceExternalTransactionId: 'bet-1', money: brl('500.00') }),
    );

    expect(win.evaluateReference(processedBet())).toEqual({ outcome: 'READY' });
  });

  test('a transaction without a reference is always ready', () => {
    expect(bet().evaluateReference(undefined)).toEqual({ outcome: 'READY' });
  });
});

/** Copies the persisted-shape state of a transaction so tests can derive variants. */
function stateOf(transaction: WagerTransaction) {
  return transaction.toState();
}
