import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../../../src/shared/domain/domain-error';
import { Money } from '../../../../src/shared/domain/money';
import { Wallet } from '../../../../src/modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../../../src/modules/wallet/domain/wallet-ledger-entry';

const OPENED_AT = new Date('2026-07-29T15:00:00.000Z');
const MOVED_AT = new Date('2026-07-29T15:00:01.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

/** Returns the DomainError code raised by `action`, so assertions name the rule that failed. */
function domainErrorCodeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.code : `UNEXPECTED: ${String(error)}`;
  }
  return 'NO_ERROR';
}

let entryCounter = 0;
function movement(transactionId: string, amount: string) {
  entryCounter += 1;
  return {
    entryId: `entry-${entryCounter}`,
    transactionId,
    money: brl(amount),
    at: MOVED_AT,
  };
}

/** Opens a wallet with `initial` and returns it together with its opening entry (if any). */
function openWallet(initial: string) {
  return Wallet.open({
    walletId: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'opening-tx',
    openingEntryId: 'opening-entry',
    openedAt: OPENED_AT,
  });
}

describe('Wallet.canCredit: the largest storable balance', () => {
  test('refuses a credit that would pass the largest balance the database stores', () => {
    const { wallet } = openWallet('999999999999999999.98');

    expect(wallet.canCredit(brl('0.01'))).toBe(true);
    expect(wallet.canCredit(brl('0.02'))).toBe(false);
  });

  test('a credit in another currency is a currency mismatch', () => {
    const { wallet } = openWallet('10.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(domainErrorCodeOf(() => wallet.canCredit(usd))).toBe('CURRENCY_MISMATCH');
  });
});

describe('Wallet.open', () => {
  test('a zero initial balance opens at version 1 without a ledger entry', () => {
    const { wallet, openingEntry } = openWallet('0.00');

    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry).toBeUndefined();
  });

  test('a positive initial balance is credited by a ledger entry and stays at version 1', () => {
    const { wallet, openingEntry } = openWallet('1000.00');

    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry?.direction).toBe('CREDIT');
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
    expect(openingEntry?.transactionId).toBe('opening-tx');
  });

  test('a negative initial balance is rejected', () => {
    const negative = brl('1.00').subtract(brl('2.00'));
    expect(
      domainErrorCodeOf(() =>
        Wallet.open({
          walletId: 'wallet-1',
          playerId: 'player-1',
          initialBalance: negative,
          openingTransactionId: 'opening-tx',
          openingEntryId: 'opening-entry',
          openedAt: OPENED_AT,
        }),
      ),
    ).toBe('INVALID_WALLET');
  });
});

describe('Wallet.debit', () => {
  test('debits the exact amount, bumps the version and returns a DEBIT entry', () => {
    const { wallet } = openWallet('100.00');

    const entry: WalletLedgerEntry = wallet.debit(movement('bet-1', '80.00'));

    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe('DEBIT');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
  });

  test('allows debiting the whole available balance, leaving zero', () => {
    const { wallet } = openWallet('25.00');

    wallet.debit(movement('bet-1', '25.00'));

    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('successive debits accumulate exactly and each bumps the version', () => {
    const { wallet } = openWallet('100.00');

    wallet.debit(movement('bet-1', '60.00'));
    wallet.debit(movement('bet-2', '30.00'));

    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(3);
  });

  test('refuses to debit more than the balance, leaving the wallet untouched', () => {
    const { wallet } = openWallet('100.00');

    expect(wallet.canDebit(brl('100.01'))).toBe(false);
    expect(domainErrorCodeOf(() => wallet.debit(movement('bet-1', '100.01')))).toBe(
      'INSUFFICIENT_BALANCE',
    );
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('rejects a debit in a different currency', () => {
    const { wallet } = openWallet('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(
      domainErrorCodeOf(() =>
        wallet.debit({ entryId: 'e', transactionId: 'bet-1', money: usd, at: MOVED_AT }),
      ),
    ).toBe('CURRENCY_MISMATCH');
  });
});

describe('Wallet rejected movements', () => {
  test('a zero-amount movement is rejected without changing balance or version', () => {
    const { wallet } = openWallet('20.00');

    expect(domainErrorCodeOf(() => wallet.credit(movement('win-0', '0.00')))).toBe(
      'INVALID_LEDGER_ENTRY',
    );
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.credit', () => {
  test('credits the amount and returns a CREDIT entry with before and after balances', () => {
    const { wallet } = openWallet('20.00');

    const entry = wallet.credit(movement('win-1', '45.50'));

    expect(wallet.balance.toString()).toBe('65.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe('CREDIT');
    expect(entry.balanceBefore.toString()).toBe('20.00');
    expect(entry.balanceAfter.toString()).toBe('65.50');
  });

  test('rejects a credit in a different currency', () => {
    const { wallet } = openWallet('20.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(
      domainErrorCodeOf(() =>
        wallet.credit({ entryId: 'e', transactionId: 'win-1', money: usd, at: MOVED_AT }),
      ),
    ).toBe('CURRENCY_MISMATCH');
  });
});

describe('Wallet ledger consistency', () => {
  test('the ledger reconstructs the materialized balance after mixed movements', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];

    entries.push(wallet.debit(movement('bet-1', '80.00')));
    entries.push(wallet.credit(movement('win-1', '150.00')));
    entries.push(wallet.debit(movement('bet-2', '20.00')));

    const reconstructed = entries.reduce(
      (sum, entry) =>
        entry.direction === 'CREDIT' ? sum.add(entry.money) : sum.subtract(entry.money),
      Money.zero('BRL'),
    );
    expect(reconstructed.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toString()).toBe('150.00');
  });
});

describe('Wallet.rehydrate', () => {
  test('restores persisted state exactly, including its version', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: brl('5.00'),
      version: 7,
      createdAt: OPENED_AT,
      updatedAt: MOVED_AT,
    });

    expect(wallet.balance.toString()).toBe('5.00');
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(MOVED_AT);
  });
});
