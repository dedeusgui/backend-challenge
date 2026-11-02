import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module';
import { readAppConfig } from '../../src/config/app-config';
import { configureHttp } from '../../src/shared/http/configure-http';
import type { OperationLogger } from '../../src/shared/observability/structured-log';

const config = readAppConfig(process.env);
const killAfterCommit: OperationLogger = (entry) => {
  if (entry.operation === 'wager.submit' && entry.status === 'PROCESSED') {
    process.kill(process.pid, 'SIGKILL');
  }
};
const app = await NestFactory.create<NestExpressApplication>(
  AppModule.register(config, { logger: killAfterCommit }),
  { bodyParser: false },
);
configureHttp(app);
app.enableShutdownHooks();
await app.listen(config.port, '0.0.0.0');
