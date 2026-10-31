import type { ProcessWagerCommand } from '../application/process-wager-transaction.use-case';
import {
  WAGER_TRANSACTION_KINDS,
  parseWagerTransactionKind,
  type WagerTransactionKind,
} from '../domain/wager-transaction-kind';
import {
  expectObject,
  expectOnlyKeys,
  optionalString,
  requiredMoney,
  requiredString,
  requiredUuid,
  RequestValidationError,
} from '../../../shared/validation/request-validation';

const ALLOWED_FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
];

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface ProcessWagerHttpRequest {
  command: Omit<ProcessWagerCommand, 'correlationId'>;
}

/**
 * Parses the transport contract. Business rules (OPENING refusal, wallet checks,
 * references) are not decided here; they belong to the use case.
 */
export function parseProcessWagerRequest(
  body: unknown,
  idempotencyKey: string | undefined,
): ProcessWagerHttpRequest {
  if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
    throw new RequestValidationError(
      'The Idempotency-Key header is required',
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new RequestValidationError(
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }

  const fields = expectObject(body, 'request body');
  expectOnlyKeys(fields, ALLOWED_FIELDS);
  return {
    command: {
      idempotencyKey,
      providerId: requiredString(fields, 'providerId'),
      externalTransactionId: requiredString(fields, 'externalTransactionId'),
      playerId: requiredString(fields, 'playerId'),
      walletId: requiredUuid(fields, 'walletId'),
      roundId: requiredString(fields, 'roundId'),
      gameId: requiredString(fields, 'gameId'),
      kind: parseKind(fields.kind),
      money: requiredMoney(fields, 'money'),
      referenceExternalTransactionId: optionalString(fields, 'referenceExternalTransactionId'),
    },
  };
}

function parseKind(value: unknown): WagerTransactionKind {
  const kind = parseWagerTransactionKind(value);
  if (kind === undefined) {
    throw new RequestValidationError(`kind must be one of ${WAGER_TRANSACTION_KINDS.join(', ')}`);
  }
  return kind;
}
