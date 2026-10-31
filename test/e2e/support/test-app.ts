import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../../../src/app.module';

export interface TestApp {
  baseUrl: string;
  close(): Promise<void>;
}

/** Starts the same AppModule the production process uses, on an ephemeral port, against one database. */
export async function startTestApp(databaseUrl: string): Promise<TestApp> {
  const app = await NestFactory.create(AppModule.register({ port: 0, databaseUrl }), {
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}
