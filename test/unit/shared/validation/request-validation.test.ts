import { describe, expect, test } from 'bun:test';
import {
  expectCorrelationId,
  expectText,
  expectUuid,
  RequestValidationError,
  requiredString,
} from '../../../../src/shared/validation/request-validation';

function rejectionOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('expectUuid', () => {
  test.each(['0192f291-27dd-7d3f-8071-5f8685deef37', '0192F291-27DD-7D3F-8071-5F8685DEEF37'])(
    'accepts the canonical form %s, in either case',
    (value) => {
      expect(expectUuid(value, 'walletId')).toBe(value);
    },
  );

  test.each([
    ['text', 'not-a-uuid'],
    ['an empty string', ''],
    ['no hyphens', '0192f29127dd7d3f80715f8685deef37'],
    ['one digit short', '0192f291-27dd-7d3f-8071-5f8685deef3'],
    ['a leading space', ' 0192f291-27dd-7d3f-8071-5f8685deef37'],
    ['a non-hex digit', '0192f291-27dd-7d3f-8071-5f8685deef3g'],
  ])('refuses %s as a RequestValidationError that names the field', (_label, value) => {
    const error = rejectionOf(() => expectUuid(value, 'walletId'));

    expect(error).toBeInstanceOf(RequestValidationError);
    expect(error instanceof Error ? error.message : '').toContain('walletId');
  });
});

describe('expectText', () => {
  test('accepts ordinary text, including accents and spaces', () => {
    expect(expectText('bet 1 é', 'externalTransactionId')).toBe('bet 1 é');
  });

  test.each([
    ['a NUL character', 'a\u0000b'],
    ['a tab', 'a\tb'],
    ['a newline', 'a\nb'],
    ['DEL', 'a\u007fb'],
  ])('refuses %s', (_label, value) => {
    expect(rejectionOf(() => expectText(value, 'externalTransactionId'))).toBeInstanceOf(
      RequestValidationError,
    );
  });

  test('refuses a blank value and a value longer than the limit', () => {
    expect(rejectionOf(() => expectText('   ', 'roundId'))).toBeInstanceOf(RequestValidationError);
    expect(rejectionOf(() => expectText('x'.repeat(256), 'roundId'))).toBeInstanceOf(
      RequestValidationError,
    );
  });
});

describe('requiredString', () => {
  test('refuses a NUL character in a field value and names the field', () => {
    const error = rejectionOf(() => requiredString({ playerId: 'a\u0000b' }, 'playerId'));

    expect(error).toBeInstanceOf(RequestValidationError);
    expect(error instanceof Error ? error.message : '').toContain('playerId');
  });
});

describe('expectCorrelationId', () => {
  test('keeps a bounded identifier of letters, digits and . _ : -', () => {
    expect(expectCorrelationId('req-2026.07_31:alpha')).toBe('req-2026.07_31:alpha');
  });

  test('is absent when the header is absent, so the caller generates one', () => {
    expect(expectCorrelationId(undefined)).toBeUndefined();
  });

  test('rejects an identifier longer than 128 characters', () => {
    const error = rejectionOf(() => expectCorrelationId('c'.repeat(129)));
    expect(error).toBeInstanceOf(RequestValidationError);
    expect(error instanceof Error ? error.message : '').toContain('x-correlation-id');
  });

  test('rejects an empty identifier', () => {
    expect(rejectionOf(() => expectCorrelationId(''))).toBeInstanceOf(RequestValidationError);
  });

  test.each(['has space', 'semi;colon', 'quote"', 'slash/path', 'emoji😀'])(
    'rejects %p, which is outside the allowed characters',
    (value) => {
      expect(rejectionOf(() => expectCorrelationId(value))).toBeInstanceOf(RequestValidationError);
    },
  );
});
