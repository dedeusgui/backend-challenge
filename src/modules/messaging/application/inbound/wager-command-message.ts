import type { ProcessWagerCommand } from '../../../wagering/application/process-wager-transaction.use-case';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  parseWagerCommandFields,
  WAGER_COMMAND_FIELDS,
} from '../../../wagering/application/wager-command-fields';
import {
  expectObject,
  expectOnlyKeys,
  requiredString,
  RequestValidationError,
} from '../../../../shared/validation/request-validation';

const ENVELOPE_KEYS = ['messageId', 'type', 'occurredAt', 'data'];
const DATA_KEYS = [...WAGER_COMMAND_FIELDS, 'idempotencyKey'];

/**
 * Maps a WagerTransactionRequested message to the same command the HTTP endpoint builds. The
 * business fields come from the parser both transports share. Any mismatch throws
 * RequestValidationError, which is a permanent failure.
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
  return {
    ...parseWagerCommandFields(data),
    idempotencyKey: requiredString(data, 'idempotencyKey', IDEMPOTENCY_KEY_MAX_LENGTH),
    correlationId: messageId,
    inbound: { consumerName, messageId },
  };
}
