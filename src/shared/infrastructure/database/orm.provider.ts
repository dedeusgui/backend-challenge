import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { ormOptions } from './orm-config';

/** Injection token for the single MikroORM instance of a process. */
export const ORM = Symbol('ORM');

export function ormProvider(databaseUrl: string) {
  return {
    provide: ORM,
    useFactory: () => MikroORM.init(ormOptions(databaseUrl)),
  };
}

/** Closes the connection pool when the process shuts down. */
@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
