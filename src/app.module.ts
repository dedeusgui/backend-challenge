import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from './config/app-config';
import { HealthController } from './health/health.controller';
import type { ApplicationContext } from './shared/application/application-context';
import { DatabaseLifecycle, ORM, ormProvider } from './shared/infrastructure/database/orm.provider';
import { MikroOrmFinancialUnitOfWork } from './shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { HttpErrorFilter } from './shared/http/http-error.filter';
import { OpenWallet } from './modules/wallet/application/open-wallet.use-case';
import { WalletController } from './modules/wallet/http/wallet.controller';
import { ProcessWagerTransaction } from './modules/wagering/application/process-wager-transaction.use-case';
import { WageringController } from './modules/wagering/http/wagering.controller';

const APPLICATION_CONTEXT = Symbol('APPLICATION_CONTEXT');

/**
 * Composition root. The HTTP process and the tests build the application through
 * this one module, so both exercise the same wiring.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, WalletController, WageringController],
      providers: [
        ormProvider(config.databaseUrl),
        DatabaseLifecycle,
        {
          provide: APPLICATION_CONTEXT,
          inject: [ORM],
          useFactory: (orm: MikroORM): ApplicationContext => ({
            unitOfWork: new MikroOrmFinancialUnitOfWork(orm),
            clock: () => new Date(),
            newId: randomUUID,
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
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
