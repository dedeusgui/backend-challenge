import { RequestValidationError } from '../../../shared/validation/request-validation';

/** Parses `limit` as a positive integer within the page bounds. Anything else is a contract error. */
export function parseLedgerLimit(
  raw: string | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (raw === undefined) {
    return defaultLimit;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maxLimit) {
    throw new RequestValidationError(`limit must be an integer between 1 and ${maxLimit}`);
  }
  return value;
}
