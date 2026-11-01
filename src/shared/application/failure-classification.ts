import {
  IdempotencyConflictError,
  MessagePayloadConflictError,
  WalletNotFoundError,
} from './application-errors';
import { DOMAIN_INPUT_ERROR_CODES, DomainError } from '../domain/domain-error';
import { RequestValidationError } from '../validation/request-validation';

/**
 * PERMANENT: the same message can never succeed, so it goes to the dead-letter queue.
 * TRANSIENT: the state may change or the infrastructure may recover, so the message is redelivered.
 */
export type FailureDisposition = 'PERMANENT' | 'TRANSIENT';

export function classifyCommandFailure(error: unknown): FailureDisposition {
  if (error instanceof RequestValidationError) {
    return 'PERMANENT';
  }
  if (error instanceof DomainError) {
    return DOMAIN_INPUT_ERROR_CODES.includes(error.code) ? 'PERMANENT' : 'TRANSIENT';
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
