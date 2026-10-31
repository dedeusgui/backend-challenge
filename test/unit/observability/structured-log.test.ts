import { describe, expect, test } from 'bun:test';
import {
  formatOperationLog,
  type OperationLog,
} from '../../../src/shared/observability/structured-log';

const OCCURRED = new Date('2026-07-29T15:00:00.000Z');

describe('formatOperationLog', () => {
  test('writes one JSON object with the required correlation fields and no amounts', () => {
    const entry: OperationLog = {
      operation: 'wager.process',
      status: 'PROCESSED',
      correlationId: 'corr-1',
      messageId: 'msg-1',
      transactionId: 'tx-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
      durationMs: 12,
    };

    const line = formatOperationLog(entry, OCCURRED);
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed).toEqual({
      time: '2026-07-29T15:00:00.000Z',
      level: 'info',
      operation: 'wager.process',
      status: 'PROCESSED',
      correlationId: 'corr-1',
      messageId: 'msg-1',
      transactionId: 'tx-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
      durationMs: 12,
    });
  });

  test('omits identifiers that are not known, instead of writing null or undefined', () => {
    const line = formatOperationLog(
      { operation: 'worker.start', status: 'OK', correlationId: 'corr-2' },
      OCCURRED,
    );

    expect('transactionId' in (JSON.parse(line) as object)).toBe(false);
  });

  test('cannot carry a money field: the type rejects it at compile time', () => {
    // `bun run typecheck` fails if the next line stops being an error, because the directive would then be unused.
    // @ts-expect-error money is deliberately not a log field
    const withMoney: OperationLog = { operation: 'x', status: 'y', money: '1.00' };
    expect(withMoney.operation).toBe('x');
  });
});
