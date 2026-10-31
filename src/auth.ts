/**
 * Operator command for API clients. It is the only way to create or revoke a key in this build.
 *
 *   bun run auth:create -- --name "provider a" --role PROVIDER --provider provider-a
 *   bun run auth:create -- --name "operations" --role OPERATOR
 *   bun run auth:revoke -- --client <clientId>
 *
 * The key is printed once. Only its hash is stored, so a lost key cannot be recovered.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateApiClient } from './modules/auth/application/create-api-client.use-case';
import { API_CLIENT_ROLES } from './modules/auth/domain/principal';
import { MikroOrmApiClientRepository } from './modules/auth/infrastructure/mikro-orm-api-client.repository';
import { ormOptions } from './shared/infrastructure/database/orm-config';

const USAGE = `usage:
  auth create --name <name> --role PROVIDER --provider <providerId>
  auth create --name <name> --role OPERATOR
  auth revoke --client <clientId>`;

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error('DATABASE_URL is required');
    return 2;
  }
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      role: { type: 'string' },
      provider: { type: 'string' },
      client: { type: 'string' },
    },
  });
  const orm = await MikroORM.init(ormOptions(databaseUrl));
  try {
    const repository = new MikroOrmApiClientRepository(orm);
    if (positionals[0] === 'create') {
      const role = API_CLIENT_ROLES.find((candidate) => candidate === values.role);
      if (values.name === undefined || role === undefined) {
        console.error(USAGE);
        return 2;
      }
      const created = await new CreateApiClient({
        repository,
        clock: () => new Date(),
        newId: randomUUID,
      }).execute({ name: values.name, role, providerId: values.provider });
      console.log(`client: ${created.clientId}`);
      console.log(`key: ${created.apiKey}`);
      console.log('The key is shown once. Store it now: only its hash is kept.');
      return 0;
    }
    if (positionals[0] === 'revoke' && values.client !== undefined) {
      const revoked = await repository.revoke(values.client, new Date());
      console.log(revoked ? `revoked: ${values.client}` : `no active client: ${values.client}`);
      return revoked ? 0 : 1;
    }
    console.error(USAGE);
    return 2;
  } finally {
    await orm.close(true);
  }
}

process.exitCode = await main();
