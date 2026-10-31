/**
 * Stable, machine-readable reason a transaction was rejected or failed.
 *
 * Providers branch on these values: a REFERENCE_* code means the request can be
 * corrected and resent, while REVERSAL_WOULD_OVERDRAW means the reversal is
 * unsafe for this wallet state. Renaming a value is a breaking contract change.
 */
export const FAILURE_CODES = [
  'INSUFFICIENT_BALANCE',
  'REVERSAL_WOULD_OVERDRAW',
  'WALLET_PLAYER_MISMATCH',
  'WALLET_CURRENCY_MISMATCH',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_CONTEXT_MISMATCH',
  'REFERENCE_KIND_NOT_ALLOWED',
  'REFERENCE_AMOUNT_MISMATCH',
  'BALANCE_LIMIT_EXCEEDED',
  'REFERENCE_ALREADY_REVERSED',
  'REFERENCE_ALREADY_SETTLED',
  'PROCESSING_FAILED',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];
