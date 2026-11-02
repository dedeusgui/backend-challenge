import { describe, test } from 'bun:test';
import * as fc from 'fast-check';
import { Money } from '../../../../src/shared/domain/money';

const MAX_NUMERIC_CENTS = 99_999_999_999_999_999_999n;
const CENTS = fc.bigInt({ min: 0n, max: MAX_NUMERIC_CENTS });

function moneyFromCents(cents: bigint): Money {
  const whole = cents / 100n;
  const fraction = String(cents % 100n).padStart(2, '0');
  return Money.from({ amount: `${whole}.${fraction}`, currency: 'BRL' });
}

describe('Money properties', () => {
  test('addition is commutative and subtracting an addend restores the other operand', () => {
    // fast-check includes the seed and shrunk counterexample in a failure report.
    fc.assert(
      fc.property(CENTS, CENTS, (leftCents, rightCents) => {
        const left = moneyFromCents(leftCents);
        const right = moneyFromCents(rightCents);
        const sum = left.add(right);

        return (
          sum.equals(right.add(left)) &&
          sum.subtract(right).equals(left) &&
          /^\d+\.\d{2}$/.test(sum.toString())
        );
      }),
      { seed: 20261102, numRuns: 300 },
    );
  });
});
