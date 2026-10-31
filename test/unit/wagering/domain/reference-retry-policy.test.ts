import { describe, expect, test } from 'bun:test';
import { referenceRetryDelayMs } from '../../../../src/modules/wagering/domain/reference-retry-policy';

describe('referenceRetryDelayMs', () => {
  test('doubles from one second with each miss', () => {
    const delays = [0, 1, 2, 3, 4, 5].map((misses) => referenceRetryDelayMs(misses));

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000]);
  });

  test('is capped at five minutes, however many misses there are', () => {
    expect(referenceRetryDelayMs(8)).toBe(256_000);
    expect(referenceRetryDelayMs(9)).toBe(300_000);
    expect(referenceRetryDelayMs(1_000)).toBe(300_000);
  });
});
