export interface AppConfig {
  port: number;
  databaseUrl: string;
}

/** Reads runtime configuration from the environment, failing fast on anything missing or malformed. */
export function readAppConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required');
  }

  return { port, databaseUrl };
}
