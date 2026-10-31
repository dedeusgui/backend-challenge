import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../../src/app.module';
import {
  CreateApiClient,
  type CreateApiClientInput,
  type CreatedApiClient,
} from '../../../src/modules/auth/application/create-api-client.use-case';
import { MikroOrmApiClientRepository } from '../../../src/modules/auth/infrastructure/mikro-orm-api-client.repository';
import { ORM } from '../../../src/shared/infrastructure/database/orm.provider';
import { SQS_ENDPOINT } from '../../integration/support/sqs-test-queues';

export interface TestApp {
  baseUrl: string;
  close(): Promise<void>;
  /** Creates an API client in the application's database, and returns its key once. */
  createApiClient(input: CreateApiClientInput): Promise<CreatedApiClient>;
  revokeApiClient(clientId: string): Promise<boolean>;
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
  const repository = new MikroOrmApiClientRepository(app.get<MikroORM>(ORM));
  const clients = new CreateApiClient({ repository, clock: () => new Date(), newId: randomUUID });
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
    createApiClient: (input) => clients.execute(input),
    revokeApiClient: (clientId) => repository.revoke(clientId, new Date()),
  };
}
