import type { ProcessWagerCommand } from '../application/process-wager-transaction.use-case';
import {
  parseIdempotencyKeyHeader,
  parseWagerCommandFields,
  WAGER_COMMAND_FIELDS,
} from '../application/wager-command-fields';
import { expectObject, expectOnlyKeys } from '../../../shared/validation/request-validation';

export interface ProcessWagerHttpRequest {
  command: Omit<ProcessWagerCommand, 'correlationId'>;
}

/**
 * Parses the transport contract: the header and the body. The business fields are parsed by the
 * same function the queue uses, so the two entry points cannot disagree about a value.
 */
export function parseProcessWagerRequest(
  body: unknown,
  idempotencyKey: string | undefined,
): ProcessWagerHttpRequest {
  const key = parseIdempotencyKeyHeader(idempotencyKey);
  const fields = expectObject(body, 'request body');
  expectOnlyKeys(fields, WAGER_COMMAND_FIELDS);
  return {
    command: {
      idempotencyKey: key,
      ...parseWagerCommandFields(fields),
    },
  };
}
