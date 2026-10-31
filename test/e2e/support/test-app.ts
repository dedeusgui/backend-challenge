import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../../../src/app.module';
import { SQS_ENDPOINT } from '../../integration/support/sqs-test-queues';

export interface TestApp {
  baseUrl: string;
  close(): Promise<void>;
}

export interface TestAppOverrides {
  sqsEndpoint?: string;
  commandQueueName?: string;
}

/** Starts the same AppModule the production process uses, on an ephemeral port, against one database. */
export async function startTestApp(
  databaseUrl: string,
  overrides: TestAppOverrides = {},
): Promise<TestApp> {
  const app = await NestFactory.create(
    AppModule.register({
      port: 0,
      databaseUrl,
      sqs: {
        region: 'us-east-1',
        endpoint: overrides.sqsEndpoint ?? SQS_ENDPOINT,
        commandQueueName: overrides.commandQueueName ?? 'wager-transactions.fifo',
        deadLetterQueueName: 'wager-transactions-dlq.fifo',
        eventsQueueName: 'wager-events.fifo',
      },
    }),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}
