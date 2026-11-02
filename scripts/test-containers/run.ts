import { randomUUID } from 'node:crypto';
import { dirname, delimiter, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Wait } from 'testcontainers';

const suites = process.argv.slice(2).filter((argument) => argument !== '--');
if (suites.length === 0) {
  suites.push(
    'test/integration/support/test-database-cleanup.test.ts',
    'test/integration/support/sqs-test-queues.test.ts',
    'test/integration/persistence/wallet-persistence.test.ts',
    'test/integration/messaging/broker-redrive.test.ts',
    'test/concurrency/support/process-cluster.test.ts',
    'test/concurrency/three-processes.test.ts',
  );
}

let postgres: StartedPostgreSqlContainer | undefined;
let localstack: StartedLocalStackContainer | undefined;
let status = 0;
const failures: unknown[] = [];
const postgresLogs: string[] = [];
const localstackLogs: string[] = [];
const startupStartedAt = performance.now();
let startupMs: number | undefined;

function captureLogs(chunks: string[]) {
  let bytes = 0;
  return (stream: Readable) => {
    stream.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      chunks.push(text);
      bytes += Buffer.byteLength(text);
      while (bytes > 64 * 1024 && chunks.length > 1) {
        bytes -= Buffer.byteLength(chunks.shift() ?? '');
      }
    });
  };
}

try {
  postgres = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('wagering')
    .withUsername('wagering')
    .withPassword('wagering')
    .withLogConsumer(captureLogs(postgresLogs))
    .withStartupTimeout(60_000)
    .withAutoRemove(true)
    .start();

  const localstackInit = resolve(import.meta.dir, '../../docker/localstack/init-sqs.sh');
  localstack = await new LocalstackContainer('localstack/localstack:4.14.0')
    .withEnvironment({ SERVICES: 'sqs', AWS_DEFAULT_REGION: 'us-east-1' })
    .withBindMounts([
      {
        source: localstackInit,
        target: '/etc/localstack/init/ready.d/init-sqs.sh',
        mode: 'ro',
      },
    ])
    .withLogConsumer(captureLogs(localstackLogs))
    .withWaitStrategy(Wait.forHttp('/_localstack/health', 4566).forStatusCode(200))
    .withStartupTimeout(90_000)
    .withAutoRemove(true)
    .start();
  startupMs = performance.now() - startupStartedAt;

  const testEnvironment = {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    DATABASE_URL: postgres.getConnectionUri(),
    SQS_ENDPOINT: localstack.getConnectionUri(),
    TEST_RESOURCE_NAMESPACE: randomUUID().replaceAll('-', '').slice(0, 12),
  };
  const testsStartedAt = performance.now();
  const testRun = Bun.spawn([process.execPath, 'test', ...suites], {
    env: testEnvironment,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  status = await testRun.exited;
  if (status !== 0) failures.push(new Error(`Test process exited with ${status}`));
  console.log(
    `[test:containers] startup=${((startupMs ?? 0) / 1000).toFixed(2)}s tests=${((performance.now() - testsStartedAt) / 1000).toFixed(2)}s`,
  );
} catch (error) {
  failures.push(error);
  if (status === 0) status = 1;
} finally {
  for (const container of [localstack, postgres]) {
    if (container !== undefined) {
      try {
        await container.stop();
      } catch (error) {
        failures.push(error);
        if (status === 0) status = 1;
      }
    }
  }
  if (failures.length > 0) {
    console.error('PostgreSQL container logs:\n', postgresLogs.join(''));
    console.error('LocalStack container logs:\n', localstackLogs.join(''));
    console.error(new AggregateError(failures, 'Testcontainers run failed'));
  }
}

process.exitCode = status;
