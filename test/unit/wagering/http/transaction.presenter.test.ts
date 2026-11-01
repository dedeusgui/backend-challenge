import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/shared/domain/money';
import { WagerTransaction } from '../../../../src/modules/wagering/domain/wager-transaction';
import type { ProcessWagerOutcome } from '../../../../src/modules/wagering/application/process-wager-transaction.use-case';
import {
  presentWagerOutcome,
  wagerOutcomeHttpStatus,
} from '../../../../src/modules/wagering/http/transaction.presenter';

function outcome(
  status: 'PROCESSED' | 'PENDING_REFERENCE' | 'REJECTED',
  idempotentReplay = false,
  failureCode?: 'INSUFFICIENT_BALANCE',
): ProcessWagerOutcome {
  const transaction = WagerTransaction.rehydrate({
    id: 'tx-1',
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    idempotencyKey: 'key-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    status,
    money: Money.from({ amount: '5.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    referenceTransactionId: undefined,
    failureCode,
    resultingBalance: Money.from({ amount: '95.00', currency: 'BRL' }),
    processedAt: undefined,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    referenceAttempts: 0,
    referenceNextAttemptAt: undefined,
  });
  return {
    transaction,
    balance: Money.from({ amount: '95.00', currency: 'BRL' }),
    idempotentReplay,
  };
}

describe('wager outcome HTTP presentation', () => {
  test('maps statuses, including a processed replay', () => {
    expect(wagerOutcomeHttpStatus(outcome('PROCESSED'))).toBe(201);
    expect(wagerOutcomeHttpStatus(outcome('PROCESSED', true))).toBe(200);
    expect(wagerOutcomeHttpStatus(outcome('PENDING_REFERENCE'))).toBe(202);
    expect(wagerOutcomeHttpStatus(outcome('REJECTED'))).toBe(422);
  });

  test('omits an undefined failure code and includes a defined one', () => {
    expect(presentWagerOutcome(outcome('PROCESSED'))).toEqual({
      transactionId: 'tx-1',
      status: 'PROCESSED',
      balance: { amount: '95.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(
      presentWagerOutcome(outcome('REJECTED', false, 'INSUFFICIENT_BALANCE')).failureCode,
    ).toBe('INSUFFICIENT_BALANCE');
  });
});
