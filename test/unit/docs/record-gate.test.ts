import { describe, expect, test } from 'bun:test';
import { parseCheckAllLog } from '../../../scripts/record-gate';

const METADATA = {
  commitSha: 'ef7b98f85e853a8c34e7cf9d86c4c34579dab02b',
  environment: 'local/docker-compose',
  recordedAt: '2026-11-01T23:00:00.000Z',
};

const APPROVED_LOG = `
$ bun test test/unit
 1 pass
 0 fail
Ran 1 tests across 1 file. [1.00ms]
$ bun test test/infra
 1 pass
 0 fail
Ran 1 tests across 1 file. [1.00ms]
$ bun test test/integration
 1 pass
 0 fail
Ran 1 tests across 1 file. [1.00ms]
$ bun test test/concurrency
 1 pass
 0 fail
Ran 1 tests across 1 file. [1.00ms]
$ bun test test/e2e
 1 pass
 0 fail
Ran 1 tests across 1 file. [1.00ms]
$ bun --bun node_modules/.bin/cucumber-js --tags 'not @bloqueado' --require 'test/features/steps/**/*.ts' 'test/features/**/*.feature'
1 scenarios (1 passed)
1 steps (1 passed)
check:all exit=0
`;

describe('parseCheckAllLog', () => {
  test('fails closed for an empty log and labels every suite as not run', () => {
    const record = parseCheckAllLog('', METADATA);

    expect(record.valid).toBe(false);
    expect(record.passed).toBe(false);
    expect(record.exitCode).toBeNull();
    expect(record.suites.every((suite) => suite.status === 'not-run')).toBe(true);
  });

  test('fails closed when a log ends before suite output and exit status', () => {
    const record = parseCheckAllLog(
      '$ bun test test/unit\n1 pass\n0 fail\nRan 1 tests across 1 file.\n',
      METADATA,
    );

    expect(record.valid).toBe(false);
    expect(record.passed).toBe(false);
    expect(record.exitCode).toBeNull();
    expect(record.suites.find((suite) => suite.key === 'unit')?.status).toBe('passed');
    expect(record.suites.find((suite) => suite.key === 'integration')?.status).toBe('not-run');
  });

  test('does not treat partial suites as approval', () => {
    const record = parseCheckAllLog(
      '$ bun test test/unit\n1 pass\n0 fail\nRan 1 tests across 1 file.\ncheck:all exit=0\n',
      METADATA,
    );

    expect(record.valid).toBe(false);
    expect(record.passed).toBe(false);
    expect(record.suites.find((suite) => suite.key === 'infra')?.status).toBe('not-run');
  });

  test('rejects inconsistent pass/fail totals', () => {
    const record = parseCheckAllLog(
      APPROVED_LOG.replace('Ran 1 tests across 1 file.', 'Ran 2 tests across 1 file.'),
      METADATA,
    );

    expect(record.valid).toBe(false);
    expect(record.passed).toBe(false);
  });

  test('requires valid commit and environment metadata', () => {
    const record = parseCheckAllLog(APPROVED_LOG, {
      commitSha: 'main',
      environment: '',
    });

    expect(record.valid).toBe(false);
    expect(record.passed).toBe(false);
  });

  test('records a complete passing gate with its commit and environment', () => {
    const record = parseCheckAllLog(APPROVED_LOG, METADATA);

    expect(record.valid).toBe(true);
    expect(record.passed).toBe(true);
    expect(record.exitCode).toBe(0);
    expect(record.commitSha).toBe(METADATA.commitSha);
    expect(record.environment).toBe(METADATA.environment);
    expect(record.suites).toHaveLength(6);
    expect(record.suites.every((suite) => suite.status === 'passed')).toBe(true);
  });

  test('records an explicit test failure as a valid failed run', () => {
    const failedLog = APPROVED_LOG.replace(
      ' 1 pass\n 0 fail\nRan 1 tests across 1 file.',
      ' 1 pass\n 1 fail\nRan 2 tests across 1 file.',
    ).replace('check:all exit=0', 'check:all exit=1');
    const record = parseCheckAllLog(failedLog, METADATA);

    expect(record.valid).toBe(true);
    expect(record.passed).toBe(false);
    expect(record.exitCode).toBe(1);
    expect(record.suites[0]?.status).toBe('failed');
  });

  test('does not count skipped tests as passing', () => {
    const skippedLog = APPROVED_LOG.replace(
      ' 1 pass\n 0 fail\nRan 1 tests across 1 file.',
      ' 1 pass\n 1 skip\n 0 fail\nRan 2 tests across 1 file.',
    );
    const record = parseCheckAllLog(skippedLog, METADATA);

    expect(record.valid).toBe(true);
    expect(record.passed).toBe(false);
    expect(record.suites[0]?.status).toBe('failed');
    expect(record.suites[0]?.skipped).toBe(1);
  });
});
