import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { readAppConfig } from './config/app-config';
import { configureHttp } from './shared/http/configure-http';
import { STDOUT_LOGGER } from './shared/observability/structured-log';

async function bootstrap(): Promise<void> {
  const config = readAppConfig(process.env);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, { logger: STDOUT_LOGGER }),
    {
      bodyParser: false,
    },
  );
  configureHttp(app);
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to start HTTP application', error);
  process.exitCode = 1;
});
