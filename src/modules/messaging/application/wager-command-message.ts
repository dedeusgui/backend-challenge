import { parseWagerTransactionKind } from '../../wagering/domain/wager-transaction-kind';
import type { ProcessWagerCommand } from '../../wagering/application/process-wager-transaction.use-case';
import {
  expectObject,
  expectOnlyKeys,
  optionalString,
  requiredMoney,
  requiredString,
  RequestValidationError,
} from '../../../shared/validation/request-validation';

const ENVELOPE_KEYS = ['messageId', 'type', 'occurredAt', 'data'];
const DATA_KEYS = [
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
];

/**
 * Maps a WagerTransactionRequested message to the same command the HTTP endpoint
 * builds. Any mismatch throws RequestValidationError, which is a permanent failure.
 */
export function parseWagerCommandMessage(body: string, consumerName: string): ProcessWagerCommand {
  const envelope = expectObject(JSON.parse(body), 'message');
  expectOnlyKeys(envelope, ENVELOPE_KEYS);
  if (envelope.type !== 'WagerTransactionRequested') {
    throw new RequestValidationError('type must be WagerTransactionRequested');
  }
  const messageId = requiredString(envelope, 'messageId');
  requiredString(envelope, 'occurredAt', 64);

  const data = expectObject(envelope.data, 'data');
  expectOnlyKeys(data, DATA_KEYS);
  const kind = parseWagerTransactionKind(data.kind);
  if (kind === undefined) {
    throw new RequestValidationError('kind is not a known transaction kind');
  }

  return {
    idempotencyKey: requiredString(data, 'idempotencyKey'),
    providerId: requiredString(data, 'providerId'),
    externalTransactionId: requiredString(data, 'externalTransactionId'),
    playerId: requiredString(data, 'playerId'),
    walletId: requiredString(data, 'walletId'),
    roundId: requiredString(data, 'roundId'),
    gameId: requiredString(data, 'gameId'),
    kind,
    money: requiredMoney(data, 'money'),
    referenceExternalTransactionId: optionalString(data, 'referenceExternalTransactionId'),
    correlationId: messageId,
    inbound: { consumerName, messageId },
  };
}
