import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from './config/app-config';
import { HealthController } from './health/health.controller';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsRegistry, METRICS_REGISTRY } from './shared/observability/metrics';
import {
  OPERATION_LOGGER,
  SILENT_LOGGER,
  type OperationLogger,
} from './shared/observability/structured-log';
import { HEALTH_SERVICE, HealthService } from './health/health.service';
import {
  createSqsClient,
  resolveQueues,
  SqsClientLifecycle,
} from './shared/infrastructure/sqs/sqs-connection';
import { SQS_CLIENT, SQS_PROBE_CLIENT } from './shared/infrastructure/sqs/sqs.tokens';
import type { ApplicationContext } from './shared/application/application-context';
import { DatabaseLifecycle, ORM, ormProvider } from './shared/infrastructure/database/orm.provider';
import { MikroOrmFinancialUnitOfWork } from './shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { HttpErrorFilter } from './shared/http/http-error.filter';
import { OpenApiController } from './shared/http/openapi.controller';
import { OpenWallet } from './modules/wallet/application/open-wallet.use-case';
import { WalletController } from './modules/wallet/http/wallet.controller';
import { ProcessWagerTransaction } from './modules/wagering/application/process-wager-transaction.use-case';
import { WageringController } from './modules/wagering/http/wagering.controller';
import { ProvidersController } from './modules/wagering/http/providers.controller';
import { WalletQueries } from './modules/wallet/application/wallet-queries';
import { WagerQueries } from './modules/wagering/application/wager-queries';
import { AuthenticateApiKey } from './modules/auth/application/authenticate-api-key.use-case';
import { MikroOrmApiClientRepository } from './modules/auth/infrastructure/mikro-orm-api-client.repository';
import { ApiKeyGuard } from './modules/auth/http/api-key.guard';

const APPLICATION_CONTEXT = Symbol('APPLICATION_CONTEXT');
const API_CLIENTS = Symbol('API_CLIENTS');

/**
 * Composition root. The HTTP process and the tests build the application through
 * this one module, so both exercise the same wiring.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig, options: { logger?: OperationLogger } = {}): DynamicModule {
    const metrics = new MetricsRegistry();
    return {
      module: AppModule,
      controllers: [
        HealthController,
        WalletController,
        WageringController,
        ProvidersController,
        MetricsController,
        OpenApiController,
      ],
      providers: [
        { provide: METRICS_REGISTRY, useValue: metrics },
        { provide: OPERATION_LOGGER, useValue: options.logger ?? SILENT_LOGGER },
        ormProvider(config.databaseUrl),
        DatabaseLifecycle,
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config.sqs) },
        {
          provide: SQS_PROBE_CLIENT,
          useFactory: () => createSqsClient(config.sqs, { probe: true }),
        },
        {
          provide: SqsClientLifecycle,
          inject: [SQS_CLIENT, SQS_PROBE_CLIENT],
          useFactory: (client: SQSClient, probe: SQSClient) =>
            new SqsClientLifecycle([client, probe]),
        },
        {
          provide: HEALTH_SERVICE,
          inject: [ORM, SQS_PROBE_CLIENT],
          useFactory: async (orm: MikroORM, probe: SQSClient) =>
            new HealthService(orm, probe, (await resolveQueues(probe, config.sqs)).commandQueueUrl),
        },
        {
          provide: APPLICATION_CONTEXT,
          inject: [ORM],
          useFactory: (orm: MikroORM): ApplicationContext => ({
            unitOfWork: new MikroOrmFinancialUnitOfWork(orm),
            clock: () => new Date(),
            newId: randomUUID,
            metrics,
          }),
        },
        {
          provide: OpenWallet,
          inject: [APPLICATION_CONTEXT],
          useFactory: (context: ApplicationContext) => new OpenWallet(context),
        },
        {
          provide: ProcessWagerTransaction,
          inject: [APPLICATION_CONTEXT],
          useFactory: (context: ApplicationContext) => new ProcessWagerTransaction(context),
        },
        {
          provide: WalletQueries,
          inject: [APPLICATION_CONTEXT],
          useFactory: (context: ApplicationContext) => new WalletQueries(context),
        },
        {
          provide: WagerQueries,
          inject: [APPLICATION_CONTEXT],
          useFactory: (context: ApplicationContext) => new WagerQueries(context),
        },
        {
          provide: API_CLIENTS,
          inject: [ORM],
          useFactory: (orm: MikroORM) => new MikroOrmApiClientRepository(orm),
        },
        {
          provide: AuthenticateApiKey,
          inject: [API_CLIENTS],
          useFactory: (clients: MikroOrmApiClientRepository) => new AuthenticateApiKey(clients),
        },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
