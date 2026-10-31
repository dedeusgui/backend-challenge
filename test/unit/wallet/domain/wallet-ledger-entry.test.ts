import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../../../src/shared/domain/domain-error';
import { Money } from '../../../../src/shared/domain/money';
import { WalletLedgerEntry } from '../../../../src/modules/wallet/domain/wallet-ledger-entry';

const CREATED_AT = new Date('2026-07-29T15:00:00.000Z');

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

function entryProps(overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'bet-1',
    direction: 'DEBIT' as const,
    money: brl('10.00'),
    balanceBefore: brl('50.00'),
    balanceAfter: brl('40.00'),
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe('WalletLedgerEntry.create', () => {
  test('accepts a DEBIT whose before minus amount equals after', () => {
    const entry = WalletLedgerEntry.create(entryProps());

    expect(entry.direction).toBe('DEBIT');
    expect(entry.isBalanced()).toBe(true);
  });

  test('accepts a CREDIT whose before plus amount equals after', () => {
    const entry = WalletLedgerEntry.create(
      entryProps({
        direction: 'CREDIT',
        balanceBefore: brl('5.00'),
        balanceAfter: brl('15.00'),
      }),
    );

    expect(entry.direction).toBe('CREDIT');
  });

  test('rejects an entry whose arithmetic does not balance', () => {
    expect(
      domainErrorCodeOf(() => WalletLedgerEntry.create(entryProps({ balanceAfter: brl('41.00') }))),
    ).toBe('INVALID_LEDGER_ENTRY');
  });

  test('rejects a CREDIT that was recorded as a debit of the same amount', () => {
    expect(
      domainErrorCodeOf(() =>
        WalletLedgerEntry.create(
          entryProps({
            direction: 'CREDIT',
            balanceBefore: brl('50.00'),
            balanceAfter: brl('40.00'),
          }),
        ),
      ),
    ).toBe('INVALID_LEDGER_ENTRY');
  });

  test('rejects a zero amount, since zero movements never produce a ledger entry', () => {
    expect(
      domainErrorCodeOf(() =>
        WalletLedgerEntry.create(entryProps({ money: brl('0.00'), balanceAfter: brl('50.00') })),
      ),
    ).toBe('INVALID_LEDGER_ENTRY');
  });

  test('rejects a negative balance after the movement', () => {
    expect(
      domainErrorCodeOf(() =>
        WalletLedgerEntry.create(
          entryProps({
            money: brl('60.00'),
            balanceAfter: brl('0.00').subtract(brl('10.00')),
          }),
        ),
      ),
    ).toBe('INVALID_LEDGER_ENTRY');
  });

  test('rejects mixed currencies across the amount and balances', () => {
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(domainErrorCodeOf(() => WalletLedgerEntry.create(entryProps({ money: usd })))).toBe(
      'CURRENCY_MISMATCH',
    );
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create(entryProps());
    expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('rebuilds a persisted entry without changing its recorded values', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'bet-1',
      direction: 'DEBIT',
      money: brl('10.00'),
      balanceBefore: brl('50.00'),
      balanceAfter: brl('40.00'),
      createdAt: CREATED_AT,
    });

    expect(entry.balanceAfter.toString()).toBe('40.00');
    expect(entry.transactionId).toBe('bet-1');
  });
});
