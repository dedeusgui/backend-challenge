import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../../../src/shared/domain/domain-error';
import { Money } from '../../../../src/shared/domain/money';

/** Returns the DomainError code raised by `action`, so assertions name the rule that failed. */
function domainErrorCodeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.code : `UNEXPECTED: ${String(error)}`;
  }
  return 'NO_ERROR';
}

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

describe('Money.from', () => {
  test('exposes the amount as a two-decimal string and its currency', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test.each([
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['0', '0.00'],
    ['007.10', '7.10'],
  ])('normalizes "%s" to a fixed two-decimal scale "%s"', (input, expected) => {
    expect(brl(input).toJSON().amount).toBe(expected);
  });

  test.each([
    ['empty string', ''],
    ['whitespace', ' 1.00'],
    ['trailing whitespace', '1.00 '],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['negative Infinity', '-Infinity'],
    ['scientific notation', '1e3'],
    ['more than two decimals', '1.234'],
    ['more than 18 integer digits (exceeds NUMERIC(20,2))', '1000000000000000000.00'],
    ['negative input', '-1.00'],
    ['explicit plus sign', '+1.00'],
    ['comma as separator', '1,00'],
    ['missing integer part', '.50'],
    ['trailing dot', '1.'],
    ['letters', 'abc'],
  ])('rejects an amount with %s', (_label, amount) => {
    expect(domainErrorCodeOf(() => brl(amount))).toBe('INVALID_MONEY');
  });

  test('rejects a JavaScript number, because money never travels as a number', () => {
    const numericAmount: unknown = 25;
    expect(
      domainErrorCodeOf(() => Money.from({ amount: numericAmount as string, currency: 'BRL' })),
    ).toBe('INVALID_MONEY');
  });

  test.each([
    ['lowercase', 'brl'],
    ['too short', 'BR'],
    ['too long', 'BRLX'],
    ['digits', 'BR1'],
    ['empty', ''],
  ])('rejects a %s currency code', (_label, currency) => {
    expect(domainErrorCodeOf(() => Money.from({ amount: '1.00', currency }))).toBe('INVALID_MONEY');
  });
});

describe('Money arithmetic', () => {
  test('zero is a zero-valued money in the given currency', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('adds decimal amounts exactly, without binary floating-point drift', () => {
    // 0.1 + 0.2 is 0.30000000000000004 with IEEE-754 doubles.
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  test('keeps exact digits beyond the default decimal.js precision', () => {
    // The exact sum has 21 significant digits. Default precision (20) rounds it to
    // 1000000000000000000.00, silently losing the centavo.
    expect(brl('999999999999999999.99').add(brl('0.02')).toString()).toBe('1000000000000000000.01');
  });

  test('subtracts decimal amounts exactly', () => {
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });

  test('allows a negative intermediate result for ledger-direction reversal', () => {
    const difference = brl('80.00').subtract(brl('100.00'));
    expect(difference.isNegative()).toBe(true);
    expect(difference.toString()).toBe('-20.00');
  });

  test('negates an amount', () => {
    expect(brl('5.00').negate().toString()).toBe('-5.00');
  });

  test('negating zero yields an unsigned zero', () => {
    const negatedZero = brl('0.00').negate();
    expect(negatedZero.toString()).toBe('0.00');
    expect(negatedZero.isNegative()).toBe(false);
  });
});

describe('Money comparisons', () => {
  test('equals compares value and currency', () => {
    expect(brl('10.00').equals(brl('10'))).toBe(true);
    expect(brl('10.00').equals(brl('10.01'))).toBe(false);
  });

  test('equals is false across currencies instead of throwing', () => {
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(brl('10.00').equals(usd)).toBe(false);
  });

  test('reports sign and ordering', () => {
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
  });
});

describe('Money currency safety', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test.each([
    ['add', () => brl('1.00').add(usd)],
    ['subtract', () => brl('1.00').subtract(usd)],
    ['isLessThan', () => brl('1.00').isLessThan(usd)],
  ])('%s rejects mixed currencies with CURRENCY_MISMATCH', (_name, action) => {
    expect(domainErrorCodeOf(action)).toBe('CURRENCY_MISMATCH');
  });
});

describe('Money immutability', () => {
  test('operations return new instances and leave the operands unchanged', () => {
    const original = brl('10.00');
    const sum = original.add(brl('5.00'));

    expect(sum).not.toBe(original);
    expect(original.toString()).toBe('10.00');
    expect(sum.toString()).toBe('15.00');
  });

  test('instances are frozen', () => {
    expect(Object.isFrozen(brl('1.00'))).toBe(true);
  });
});

describe('Money serialization', () => {
  test('toString returns only the decimal amount', () => {
    expect(brl('12.30').toString()).toBe('12.30');
  });

  test('a serialized value can be rebuilt into an equal money', () => {
    const original = brl('42.42');
    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });
});
