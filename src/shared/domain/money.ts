import { Decimal } from 'decimal.js';
import { DomainError } from './domain-error';

export interface MoneyProps {
  /** Decimal string with at most two fractional digits, e.g. "25.00". */
  amount: string;
  /** ISO-4217 alphabetic code, e.g. "BRL". */
  currency: string;
}

/**
 * Decimal arithmetic context for money. The default precision (20 significant
 * digits) is too small for a sum of two NUMERIC(20,2) operands, which needs 21.
 */
const MoneyDecimal = Decimal.clone({ precision: 40 });

/** Mirrors the persisted NUMERIC(20,2) column: at most 18 integer digits and 2 fractional ones. */
const AMOUNT_PATTERN = /^\d{1,18}(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Immutable monetary amount. Arithmetic is exact; there is no floating-point path. */
export class Money {
  readonly currency: string;
  private readonly value: Decimal;

  private constructor(currency: string, value: Decimal) {
    this.currency = currency;
    this.value = value;
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new DomainError('INVALID_MONEY', `Invalid money amount: ${String(props.amount)}`);
    }
    if (!CURRENCY_PATTERN.test(props.currency)) {
      throw new DomainError('INVALID_MONEY', `Invalid currency code: ${props.currency}`);
    }
    return new Money(props.currency, new MoneyDecimal(props.amount));
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.currency, this.value.plus(other.value));
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.currency, this.value.minus(other.value));
  }

  negate(): Money {
    return new Money(this.currency, this.value.negated());
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Different currencies are never equal; this is a predicate, so it does not throw. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `Cannot combine ${this.currency} with ${other.currency}`,
      );
    }
  }
}
