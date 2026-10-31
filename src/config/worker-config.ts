import { readSqsSettings, type SqsSettings } from './app-config';

export interface WorkerConfig {
  databaseUrl: string;
  sqs: SqsSettings;
  consumerVisibilitySeconds: number;
  outboxBatchSize: number;
  outboxLeaseMs: number;
  outboxIdleDelayMs: number;
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
    outboxLeaseMs: positiveInteger(env, 'OUTBOX_LEASE_MS', 30_000),
    outboxIdleDelayMs: positiveInteger(env, 'OUTBOX_IDLE_DELAY_MS', 500),
  };
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
