export type DomainErrorCode =
  | 'INVALID_MONEY'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_WALLET'
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_LEDGER_ENTRY'
  | 'INVALID_TRANSACTION'
  | 'INVALID_TRANSACTION_TRANSITION'
  | 'INVALID_OUTBOX_TRANSITION'
  | 'INVALID_INBOX_TRANSITION'
  | 'INVALID_API_CLIENT';

export const DOMAIN_INPUT_ERROR_CODES: readonly DomainErrorCode[] = [
  'INVALID_MONEY',
  'CURRENCY_MISMATCH',
  'INVALID_WALLET',
  'INVALID_TRANSACTION',
];

/**
 * Violation of a domain rule on input or on an operation.
 *
 * Thrown for invalid contracts and programming errors. Expected business
 * outcomes (for example insufficient balance) are checked before the operation
 * so that they are returned as values, not raised as exceptions.
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
