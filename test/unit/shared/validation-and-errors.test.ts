import { describe, expect, spyOn, test } from 'bun:test';
import { HttpException, HttpStatus } from '@nestjs/common';
import { parseLedgerLimit } from '../../../src/modules/wallet/http/ledger-query.request';
import { oneOf } from '../../../src/shared/infrastructure/database/stored-values';
import { toErrorResponse } from '../../../src/shared/http/error-response';
import { HttpErrorFilter } from '../../../src/shared/http/http-error.filter';
import { DomainError } from '../../../src/shared/domain/domain-error';
import {
  expectObject,
  expectOnlyKeys,
  optionalString,
  requiredString,
  requiredUuid,
  RequestValidationError,
} from '../../../src/shared/validation/request-validation';
import {
  describeError,
  formatOperationLog,
  logOperation,
} from '../../../src/shared/observability/structured-log';

/**
 * Input validation, the mapping of failures to responses, and the operation log. Each refusal names the branch
 * it covers: a value of the wrong shape, a number out of range, a failure that the mapping must classify.
 */

function refused(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('request validation', () => {
  test('an object is required: arrays, null and scalars are refused', () => {
    for (const value of [[], null, 'text', 3]) {
      expect(refused(() => expectObject(value, 'body'))).toBeInstanceOf(RequestValidationError);
    }
    expect(expectObject({ a: 1 }, 'body')).toEqual({ a: 1 });
  });

  test('a key outside the allowed list is refused', () => {
    expect(refused(() => expectOnlyKeys({ a: 1, extra: 2 }, ['a']))).toBeInstanceOf(
      RequestValidationError,
    );
  });

  test('a required string must be a string, and a required UUID must be a UUID', () => {
    expect(refused(() => requiredString({ name: 7 }, 'name'))).toBeInstanceOf(
      RequestValidationError,
    );
    expect(refused(() => requiredUuid({ id: 'not-a-uuid' }, 'id'))).toBeInstanceOf(
      RequestValidationError,
    );
    expect(requiredUuid({ id: '0192f291-27dd-7d3f-8071-5f8685deef37' }, 'id')).toBe(
      '0192f291-27dd-7d3f-8071-5f8685deef37',
    );
  });

  test('an optional string is absent for undefined or null, and refused for any other non-string', () => {
    expect(optionalString({}, 'note')).toBeUndefined();
    expect(optionalString({ note: null }, 'note')).toBeUndefined();
    expect(refused(() => optionalString({ note: 9 }, 'note'))).toBeInstanceOf(
      RequestValidationError,
    );
    expect(optionalString({ note: 'ok' }, 'note')).toBe('ok');
  });

  test('the ledger page limit defaults, and refuses anything that is not an integer within the maximum', () => {
    expect(parseLedgerLimit(undefined, 50, 200)).toBe(50);
    for (const raw of ['0', '201', '2.5', 'many']) {
      expect(refused(() => parseLedgerLimit(raw, 50, 200))).toBeInstanceOf(RequestValidationError);
    }
    expect(parseLedgerLimit('200', 50, 200)).toBe(200);
  });
});

describe('the mapping of a failure to a response', () => {
  test('a framework error keeps its status when the mapping knows it, and any other client error is an invalid request', () => {
    expect(toErrorResponse(new HttpException('big', HttpStatus.PAYLOAD_TOO_LARGE)).status).toBe(
      413,
    );
    expect(toErrorResponse(new HttpException('gone', HttpStatus.NOT_FOUND)).body.error.code).toBe(
      'NOT_FOUND',
    );
    expect(toErrorResponse(new HttpException('teapot', 418))).toEqual({
      status: 418,
      body: { error: { code: 'INVALID_REQUEST', message: 'The request could not be parsed' } },
    });
  });

  test('a server error from the framework is an internal error, and so is anything unknown', () => {
    expect(toErrorResponse(new HttpException('down', 503)).status).toBe(500);
    expect(toErrorResponse(new Error('secret detail')).body.error.message).toBe(
      'An unexpected error occurred',
    );
    expect(toErrorResponse('not even an error').status).toBe(500);
  });

  test('a validation error is a 400, and a domain error is classified by its code', () => {
    expect(toErrorResponse(new RequestValidationError('bad')).status).toBe(400);
    expect(toErrorResponse(new DomainError('INVALID_TRANSACTION', 'x')).body.error.code).toBe(
      'INVALID_TRANSACTION',
    );
    // A domain code that describes a bug, not a caller's mistake, is an internal error and reveals nothing.
    expect(toErrorResponse(new DomainError('INVALID_TRANSACTION_TRANSITION', 'x')).status).toBe(
      500,
    );
  });
});

describe('the exception filter', () => {
  function hostRecording(): {
    host: Parameters<HttpErrorFilter['catch']>[1];
    sent: Array<{ status: number; body: unknown }>;
  } {
    const sent: Array<{ status: number; body: unknown }> = [];
    const reply = {
      status(code: number) {
        sent.push({ status: code, body: undefined });
        return reply;
      },
      json(body: unknown) {
        const last = sent[sent.length - 1];
        if (last !== undefined) {
          last.body = body;
        }
        return reply;
      },
    };
    return {
      host: { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as Parameters<
        HttpErrorFilter['catch']
      >[1],
      sent,
    };
  }

  test('a framework error that is not a client error is answered as an internal error', () => {
    const filter = new HttpErrorFilter();
    const { host, sent } = hostRecording();
    filter.catch(new HttpException('down', 503), host);
    expect(sent).toEqual([
      {
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      },
    ]);
  });

  test('a client error is answered without a server-side log, with the status it carries', () => {
    const filter = new HttpErrorFilter();
    const { host, sent } = hostRecording();
    filter.catch(new RequestValidationError('bad field'), host);
    expect(sent[0]?.status).toBe(400);
  });
});

describe('the stored values', () => {
  test('a value that is not one of the allowed ones is refused, and the message names what was stored', () => {
    expect(oneOf(['A', 'B'] as const, 'A', 'status')).toBe('A');
    expect(refused(() => oneOf(['A', 'B'] as const, 'C', 'status'))).toEqual(
      new Error('Unknown status stored in the database: C'),
    );
  });
});

describe('the operation log', () => {
  test('describes an error by its name and code, and an unknown thing by nothing', () => {
    const coded = Object.assign(new Error('x'), { code: 'INSUFFICIENT_BALANCE' });
    expect(describeError(coded)).toEqual({ errorName: 'Error', errorCode: 'INSUFFICIENT_BALANCE' });
    expect(describeError(new Error('no code'))).toEqual({ errorName: 'Error' });
    expect(describeError('plain')).toEqual({ errorName: 'NonError' });
  });

  test('formats one JSON line with the time it was written, and writes it to standard output', () => {
    const at = new Date('2026-07-29T15:00:00.000Z');
    const line = formatOperationLog({ operation: 'command.settle', status: 'APPLIED' }, at);
    expect(JSON.parse(line)).toMatchObject({
      operation: 'command.settle',
      status: 'APPLIED',
      time: at.toISOString(),
    });

    const written: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      logOperation({ operation: 'worker.consume', status: 'ok' });
    } finally {
      spy.mockRestore();
    }
    expect(written).toHaveLength(1);
    expect(written[0]?.endsWith('\n')).toBe(true);
  });
});
