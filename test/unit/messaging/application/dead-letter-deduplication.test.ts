import { describe, expect, test } from 'bun:test';
import { deadLetterDeduplicationId } from '../../../../src/modules/messaging/application/wager-command-consumer';

describe('deadLetterDeduplicationId', () => {
  test('one body always gets one id, so a repeated send is recognised as the same copy', () => {
    const body = '{"messageId":"msg-1","type":"WagerTransactionRequested"}';

    expect(deadLetterDeduplicationId(body)).toBe(deadLetterDeduplicationId(body));
  });

  test('two bodies get two ids', () => {
    expect(deadLetterDeduplicationId('{"messageId":"msg-1"}')).not.toBe(
      deadLetterDeduplicationId('{"messageId":"msg-2"}'),
    );
  });

  test('the id fits the FIFO limit of 128 characters, whatever the body length', () => {
    const id = deadLetterDeduplicationId('x'.repeat(10_000));

    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });
});
