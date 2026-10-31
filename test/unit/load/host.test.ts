import { describe, expect, test } from 'bun:test';
import { planPinning } from '../../../test/load/host';

describe('the pinning plan', () => {
  test('gives the stack the first CPUs and the generator the rest', () => {
    const plan = planPinning({ allowed: [0, 1, 2, 3], stackCount: 2, pinnable: true });
    expect(plan.stack).toEqual([0, 1]);
    expect(plan.generator).toEqual([2, 3]);
    expect(plan.pinned).toBe(true);
  });

  test('leaves the generator sharing the CPUs when the stack has all of them', () => {
    const plan = planPinning({ allowed: [0, 1, 2, 3], stackCount: 4, pinnable: true });
    expect(plan.stack).toEqual([0, 1, 2, 3]);
    expect(plan.generator).toEqual([]);
  });

  test('pins nothing where pinning is not available, and says so', () => {
    const plan = planPinning({ allowed: [0, 1, 2, 3], stackCount: 2, pinnable: false });
    expect(plan.pinned).toBe(false);
    expect(plan.stack).toEqual([0, 1, 2, 3]);
  });

  test('refuses a stack that asks for more CPUs than the host allows', () => {
    expect(() => planPinning({ allowed: [0, 1], stackCount: 3, pinnable: true })).toThrow();
    expect(() => planPinning({ allowed: [0, 1], stackCount: 0, pinnable: true })).toThrow();
  });
});
