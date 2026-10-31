import type { Money } from '../../../shared/domain/money';
import {
  expectText,
  optionalString,
  requiredMoney,
  requiredString,
  requiredUuid,
  RequestValidationError,
} from '../../../shared/validation/request-validation';
import {
  WAGER_TRANSACTION_KINDS,
  parseWagerTransactionKind,
  type WagerTransactionKind,
} from '../domain/wager-transaction-kind';

/**
 * The business fields of a wager command, as both transports carry them. HTTP and the queue parse
 * them here, so one field has one rule: a value refused on one path is refused on the other.
 */
export const WAGER_COMMAND_FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
] as const;

export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export interface WagerCommandFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
}

/** Parses the business fields. Business rules (OPENING, wallet checks, references) are decided by the use case. */
export function parseWagerCommandFields(source: Record<string, unknown>): WagerCommandFields {
  return {
    providerId: requiredString(source, 'providerId'),
    externalTransactionId: requiredString(source, 'externalTransactionId'),
    playerId: requiredString(source, 'playerId'),
    walletId: requiredUuid(source, 'walletId'),
    roundId: requiredString(source, 'roundId'),
    gameId: requiredString(source, 'gameId'),
    kind: parseKind(source.kind),
    money: requiredMoney(source, 'money'),
    referenceExternalTransactionId: optionalString(source, 'referenceExternalTransactionId'),
  };
}

/** The Idempotency-Key header: required, not blank, bounded, and free of control characters. */
export function parseIdempotencyKeyHeader(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new RequestValidationError(
      'The Idempotency-Key header is required',
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  }
  return expectText(value, 'Idempotency-Key', IDEMPOTENCY_KEY_MAX_LENGTH);
}

function parseKind(value: unknown): WagerTransactionKind {
  const kind = parseWagerTransactionKind(value);
  if (kind === undefined) {
    throw new RequestValidationError(`kind must be one of ${WAGER_TRANSACTION_KINDS.join(', ')}`);
  }
  return kind;
}
