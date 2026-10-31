import { RequestValidationError } from '../../../shared/validation/request-validation';

/**
 * An opaque cursor: callers pass it back without reading it. It wraps the ledger
 * sequence number, and a value that does not decode is rejected rather than guessed.
 */
export function encodeLedgerCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ seq }), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string): string {
  const invalid = () => new RequestValidationError('cursor is not valid', 'INVALID_CURSOR');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('seq' in decoded) ||
    typeof decoded.seq !== 'string'
  ) {
    throw invalid();
  }
  if (!/^[1-9][0-9]*$/.test(decoded.seq)) {
    throw invalid();
  }
  return decoded.seq;
}
