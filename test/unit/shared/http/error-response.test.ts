import { describe, expect, test } from 'bun:test';
import { toErrorResponse } from '../../../../src/shared/http/error-response';
import { DomainError } from '../../../../src/shared/domain/domain-error';
import { ConcurrencyConflictError } from '../../../../src/shared/application/application-errors';

describe('toErrorResponse', () => {
  test('an unknown error is a 500 INTERNAL_ERROR, and its message does not reach the caller', () => {
    const response = toErrorResponse(new Error('connection to 10.0.0.5 refused for amount 25.00'));

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.5');
    expect(JSON.stringify(response.body)).not.toContain('25.00');
  });

  test('a domain error that is a bug in the code, not a caller mistake, is also a 500 without its message', () => {
    const response = toErrorResponse(
      new DomainError('INVALID_OUTBOX_TRANSITION', 'row 42 is published'),
    );

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('row 42');
  });

  test('a lost race that used up its retries is a 503 with retry-after, so the caller knows to resend', () => {
    const response = toErrorResponse(new ConcurrencyConflictError('wallet changed'));

    expect(response.status).toBe(503);
    expect(response.headers).toEqual({ 'retry-after': '1' });
  });
});
