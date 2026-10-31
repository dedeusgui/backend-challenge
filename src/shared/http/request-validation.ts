import { Money } from '../domain/money';

/** A request body or header does not match the contract. The message names the field, never the value. */
export class RequestValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'INVALID_REQUEST') {
    super(message);
    this.name = 'RequestValidationError';
    this.code = code;
  }
}

export function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestValidationError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Rejects keys outside the contract, so that a misspelled or extra field is visible to the caller. */
export function expectOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new RequestValidationError(`Unknown field(s): ${unknown.join(', ')}`);
  }
}

export function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 255,
): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new RequestValidationError(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 255,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new RequestValidationError(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

/** Parses `{ "amount": "25.00", "currency": "BRL" }`. Malformed amounts surface as INVALID_MONEY from Money. */
export function requiredMoney(body: Record<string, unknown>, field: string): Money {
  const value = expectObject(body[field], field);
  expectOnlyKeys(value, ['amount', 'currency']);
  if (typeof value.amount !== 'string' || typeof value.currency !== 'string') {
    throw new RequestValidationError(`${field} must contain string amount and currency`);
  }
  return Money.from({ amount: value.amount, currency: value.currency });
}
