import { describe, expect, test } from 'bun:test';
import { parseCheckAllLog } from '../../../scripts/record-gate';

const METADATA = {
  commitSha: 'ef7b98f85e853a8c34e7cf9d86c4c34579dab02b',
  environment: 'local/docker-compose',
  recordedAt: '2026-11-01T23:00:00.000Z',
};

const APPROVED_LOG = `
$ bun run check:fast && bun run test:infra && bun run test:integration && bun run test:concurrency && bun run test:e2e && bun run test:features
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
$ mkdir -p test-results && bun --bun node_modules/.bin/cucumber-js --tags 'not @bloqueado' --require 'test/features/steps/**/*.ts' --format progress --format junit:test-results/cucumber.junit.xml --format message:test-results/cucumber.ndjson 'test/features/**/*.feature'
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

  test('requires the check:all command marker', () => {
    const record = parseCheckAllLog(
      APPROVED_LOG.replace(
        '$ bun run check:fast && bun run test:infra && bun run test:integration && bun run test:concurrency && bun run test:e2e && bun run test:features\n',
        '',
      ),
      METADATA,
    );

    expect(record.valid).toBe(false);
    expect(record.passed).toBe(false);
    expect(record.errors).toContain('comando check:all ausente ou duplicado');
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

  test('does not accept a filtered Bun suite as the complete suite', () => {
    const filteredLog = APPROVED_LOG.replace(
      '$ bun test test/unit\n',
      "$ bun test test/unit --test-name-pattern 'one passing test'\n",
    );
    const record = parseCheckAllLog(filteredLog, METADATA);

    expect(record.valid).toBe(false);
    expect(record.passed).toBe(false);
    expect(record.suites.find((suite) => suite.key === 'unit')?.status).toBe('not-run');
  });

  test('requires the configured Cucumber tag exclusion and reports', () => {
    const incompleteLog = APPROVED_LOG.replace(
      "$ mkdir -p test-results && bun --bun node_modules/.bin/cucumber-js --tags 'not @bloqueado' --require 'test/features/steps/**/*.ts' --format progress --format junit:test-results/cucumber.junit.xml --format message:test-results/cucumber.ndjson 'test/features/**/*.feature'",
      "$ mkdir -p test-results && bun --bun node_modules/.bin/cucumber-js --require 'test/features/steps/**/*.ts' 'test/features/**/*.feature'",
    );
    const record = parseCheckAllLog(incompleteLog, METADATA);

    expect(record.valid).toBe(false);
    expect(record.passed).toBe(false);
    expect(record.suites.find((suite) => suite.key === 'features')?.status).toBe('not-run');
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
    expect(record.schemaVersion).toBe(3);
    expect(record.command).toBe('bun run check:all');
    expect(record.limitations).toContain(
      'Cucumber scenarios tagged @bloqueado are excluded and are not counted as executed.',
    );
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

  test('does not mark Cucumber passed when steps report a failure', () => {
    const inconsistentLog = APPROVED_LOG.replace('1 steps (1 passed)', '1 steps (1 failed)');
    const record = parseCheckAllLog(inconsistentLog, METADATA);

    expect(record.valid).toBe(true);
    expect(record.passed).toBe(false);
    expect(record.suites.find((suite) => suite.key === 'features')?.status).toBe('failed');
    expect(record.cucumber.steps.failed).toBe(1);
  });

  test('rejects a Cucumber summary that repeats a status category', () => {
    const malformedLog = APPROVED_LOG.replace(
      '1 scenarios (1 passed)',
      '2 scenarios (1 passed, 2 passed)',
    );
    const record = parseCheckAllLog(malformedLog, METADATA);

    expect(record.valid).toBe(false);
    expect(record.passed).toBe(false);
    expect(record.errors).toContain('features/cenários: status duplicado');
  });
});
