import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  MessagePayloadConflictError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../application/application-errors';
import { HttpException } from '@nestjs/common';
import { DomainError } from '../domain/domain-error';
import { RequestValidationError } from '../validation/request-validation';

export interface ErrorResponse {
  status: number;
  body: { error: { code: string; message: string } };
  headers?: Record<string, string>;
}

/** Domain codes that describe a contract the caller got wrong. Other domain codes indicate a bug. */
const CALLER_DOMAIN_CODES: readonly string[] = [
  'INVALID_MONEY',
  'CURRENCY_MISMATCH',
  'INVALID_WALLET',
  'INVALID_TRANSACTION',
];

/**
 * Maps every failure to one stable, machine-readable code and status. Unknown
 * errors are reported as INTERNAL_ERROR without their message, so internals do
 * not leak to callers.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof HttpException) {
    // Framework-level failures keep their status: an unknown route is 404, malformed JSON is 400.
    return httpFailure(error.getStatus());
  }
  if (error instanceof RequestValidationError) {
    return failure(400, error.code, error.message);
  }
  if (error instanceof DomainError) {
    return CALLER_DOMAIN_CODES.includes(error.code)
      ? failure(400, error.code, error.message)
      : failure(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return failure(404, error.code, error.message);
  }
  if (
    error instanceof WalletAlreadyExistsError ||
    error instanceof IdempotencyConflictError ||
    error instanceof MessagePayloadConflictError
  ) {
    return failure(409, error.code, error.message);
  }
  if (error instanceof ConcurrencyConflictError) {
    return {
      ...failure(503, error.code, 'The wallet is busy; retry the request'),
      headers: { 'retry-after': '1' },
    };
  }
  return failure(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

function httpFailure(status: number): ErrorResponse {
  if (status === 404) {
    return failure(404, 'NOT_FOUND', 'No route matches this request');
  }
  if (status === 401) {
    return {
      ...failure(401, 'UNAUTHENTICATED', 'A valid API key is required'),
      headers: { 'www-authenticate': 'Bearer' },
    };
  }
  if (status === 403) {
    return failure(403, 'FORBIDDEN', 'This API key may not perform the operation');
  }
  if (status >= 400 && status < 500) {
    return failure(status, 'INVALID_REQUEST', 'The request could not be parsed');
  }
  return failure(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

function failure(status: number, code: string, message: string): ErrorResponse {
  return { status, body: { error: { code, message } } };
}
