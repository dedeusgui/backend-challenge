import { readSqsSettings, type SqsSettings } from './app-config';

export interface WorkerConfig {
  databaseUrl: string;
  sqs: SqsSettings;
  consumerVisibilitySeconds: number;
  outboxBatchSize: number;
  outboxMaxAttempts: number;
  outboxRetentionDays: number;
  outboxLeaseMs: number;
  outboxIdleDelayMs: number;
  /** The port of the worker's own HTTP surface (liveness and metrics). Unset means no surface. */
  httpPort: number | undefined;
}

export function readWorkerConfig(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required');
  }
  return {
    databaseUrl,
    sqs: readSqsSettings(env),
    consumerVisibilitySeconds: positiveInteger(env, 'CONSUMER_VISIBILITY_SECONDS', 30),
    outboxBatchSize: positiveInteger(env, 'OUTBOX_BATCH_SIZE', 20),
    outboxMaxAttempts: positiveInteger(env, 'OUTBOX_MAX_ATTEMPTS', 10),
    outboxRetentionDays: positiveInteger(env, 'OUTBOX_RETENTION_DAYS', 7),
    outboxLeaseMs: positiveInteger(env, 'OUTBOX_LEASE_MS', 30_000),
    outboxIdleDelayMs: positiveInteger(env, 'OUTBOX_IDLE_DELAY_MS', 500),
    httpPort: tcpPort(env, 'WORKER_HTTP_PORT'),
  };
}

export function readOutboxMaxAttempts(env: Readonly<Record<string, string | undefined>>): number {
  return positiveInteger(env, 'OUTBOX_MAX_ATTEMPTS', 10);
}

export function readOutboxRetentionDays(env: Readonly<Record<string, string | undefined>>): number {
  return positiveInteger(env, 'OUTBOX_RETENTION_DAYS', 7);
}

function tcpPort(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a port number from 1 to 65535`);
  }
  return value;
}

function positiveInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
