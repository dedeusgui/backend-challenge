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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RequestValidationError(`${label} must be a JSON object`);
  }
  return value;
}

/** Rejects keys outside the contract, so that a misspelled or extra field is visible to the caller. */
export function expectOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new RequestValidationError(`Unknown field(s): ${unknown.join(', ')}`);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An identifier the database stores as a UUID. A malformed one is refused here, not by PostgreSQL. */
export function expectUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new RequestValidationError(`${label} must be a UUID`);
  }
  return value;
}

/** Text that a text column can store: non-empty, bounded, and free of control characters, NUL included. */
export function expectText(value: string, label: string, maxLength = 255): string {
  if (value.trim() === '' || value.length > maxLength) {
    throw new RequestValidationError(
      `${label} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  if (hasControlCharacter(value)) {
    throw new RequestValidationError(`${label} must not contain control characters`);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The correlation id is copied into events and logs, so its size and alphabet are bounded. An
 * absent header is not an error: the caller generates an identifier instead.
 */
export function expectCorrelationId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!CORRELATION_ID_PATTERN.test(value)) {
    throw new RequestValidationError(
      'x-correlation-id must be 1 to 128 characters of letters, digits, ".", "_", ":" or "-"',
    );
  }
  return value;
}

export function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 255,
): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new RequestValidationError(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return expectText(value, field, maxLength);
}

export function requiredUuid(body: Record<string, unknown>, field: string): string {
  return expectUuid(requiredString(body, field), field);
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
  if (typeof value !== 'string') {
    throw new RequestValidationError(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return expectText(value, field, maxLength);
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
