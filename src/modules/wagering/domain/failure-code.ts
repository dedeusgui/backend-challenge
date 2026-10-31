/**
 * Stable, machine-readable reason a transaction was rejected or failed.
 *
 * Providers branch on these values: a REFERENCE_* code means the request can be
 * corrected and resent, while REVERSAL_WOULD_OVERDRAW means the reversal is
 * unsafe for this wallet state. Renaming a value is a breaking contract change.
 */
export type FailureCode =
  | 'INSUFFICIENT_BALANCE'
  | 'REVERSAL_WOULD_OVERDRAW'
  | 'WALLET_PLAYER_MISMATCH'
  | 'WALLET_CURRENCY_MISMATCH'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_NOT_PROCESSED'
  | 'REFERENCE_CONTEXT_MISMATCH'
  | 'REFERENCE_KIND_NOT_ALLOWED'
  | 'REFERENCE_AMOUNT_MISMATCH'
  | 'REFERENCE_ALREADY_REVERSED'
  | 'PROCESSING_FAILED';
