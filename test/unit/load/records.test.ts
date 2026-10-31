import { describe, expect, test } from 'bun:test';
import { isRunRecord } from '../../../test/load/records';
import { runFixture } from './run-fixture';

/** A run as JSON reads it back from disk: no types survive, only the shape. */
function fromJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('the run record that the driver writes and the report reads', () => {
  test('accepts a run as it comes back from its JSON file', () => {
    expect(isRunRecord(fromJson(runFixture()))).toBe(true);
  });

  test('accepts a run that has no agreed rate, because no step passed', () => {
    expect(isRunRecord(fromJson(runFixture({ agreedRate: null, firstFailingRate: 10 })))).toBe(
      true,
    );
  });

  test('refuses a file of another format or version', () => {
    expect(isRunRecord(fromJson({ ...runFixture(), version: 2 }))).toBe(false);
    expect(isRunRecord(fromJson({ ...runFixture(), format: 'something-else' }))).toBe(false);
  });

  test('refuses a run whose steps are missing or malformed, rather than reporting a partial run', () => {
    expect(isRunRecord(fromJson({ ...runFixture(), steps: undefined }))).toBe(false);
    expect(isRunRecord(fromJson({ ...runFixture(), steps: [{ rate: '100' }] }))).toBe(false);
  });

  test('refuses a run without its stack CPU count', () => {
    expect(isRunRecord(fromJson({ ...runFixture(), stackCpus: undefined }))).toBe(false);
  });
});
