import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { readAppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const config = readAppConfig(process.env);
  const app = await NestFactory.create(AppModule.register(config));
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to start HTTP application', error);
  process.exitCode = 1;
});
