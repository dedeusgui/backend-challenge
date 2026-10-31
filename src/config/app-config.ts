export interface SqsSettings {
  region: string;
  /** Set for LocalStack or another emulator. Leave unset to use AWS with GetQueueUrl. */
  endpoint: string | undefined;
  commandQueueName: string;
  deadLetterQueueName: string;
  eventsQueueName: string;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  sqs: SqsSettings;
}

/** Reads runtime configuration from the environment, failing fast on anything missing or malformed. */
export function readAppConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  return {
    port: readPort(env.PORT ?? '3000'),
    databaseUrl: readRequired(env, 'DATABASE_URL'),
    sqs: readSqsSettings(env),
  };
}

export function readSqsSettings(env: Readonly<Record<string, string | undefined>>): SqsSettings {
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: env.SQS_ENDPOINT?.trim() || undefined,
    commandQueueName: env.SQS_COMMAND_QUEUE ?? 'wager-transactions.fifo',
    deadLetterQueueName: env.SQS_COMMAND_DLQ ?? 'wager-transactions-dlq.fifo',
    eventsQueueName: env.SQS_EVENTS_QUEUE ?? 'wager-events.fifo',
  };
}

function readPort(raw: string): number {
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function readRequired(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}
