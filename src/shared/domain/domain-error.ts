export type DomainErrorCode = 'INVALID_MONEY' | 'CURRENCY_MISMATCH';

/**
 * Violation of a domain rule on input or on an operation.
 *
 * Thrown for invalid contracts and programming errors. Expected business
 * outcomes (for example insufficient balance) are returned as values instead.
 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
