import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { readAppConfig } from './config/app-config';
import { STDOUT_LOGGER } from './shared/observability/structured-log';

async function bootstrap(): Promise<void> {
  const config = readAppConfig(process.env);
  const app = await NestFactory.create(AppModule.register(config, { logger: STDOUT_LOGGER }));
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to start HTTP application', error);
  process.exitCode = 1;
});
