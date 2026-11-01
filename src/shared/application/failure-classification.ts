import {
  IdempotencyConflictError,
  MessagePayloadConflictError,
  WalletNotFoundError,
} from '../../../shared/application/application-errors';
import { DomainError } from '../../../shared/domain/domain-error';
import { RequestValidationError } from '../../../shared/validation/request-validation';

/**
 * PERMANENT: the same message can never succeed, so it goes to the dead-letter queue.
 * TRANSIENT: the state may change or the infrastructure may recover, so the message is redelivered.
 */
export type FailureDisposition = 'PERMANENT' | 'TRANSIENT';

const PERMANENT_DOMAIN_CODES: readonly string[] = [
  'INVALID_MONEY',
  'CURRENCY_MISMATCH',
  'INVALID_WALLET',
  'INVALID_TRANSACTION',
];

export function classifyCommandFailure(error: unknown): FailureDisposition {
  if (error instanceof RequestValidationError) {
    return 'PERMANENT';
  }
  if (error instanceof DomainError) {
    return PERMANENT_DOMAIN_CODES.includes(error.code) ? 'PERMANENT' : 'TRANSIENT';
  }
  if (
    error instanceof WalletNotFoundError ||
    error instanceof IdempotencyConflictError ||
    error instanceof MessagePayloadConflictError
  ) {
    return 'PERMANENT';
  }
  return 'TRANSIENT';
}
