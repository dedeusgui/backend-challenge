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

async function handleCreate(
  repository: MikroOrmApiClientRepository,
  values: { name?: string; role?: string; provider?: string },
): Promise<number> {
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

async function handleRevoke(
  repository: MikroOrmApiClientRepository,
  client: string | undefined,
): Promise<number> {
  if (client === undefined) {
    console.error(USAGE);
    return 2;
  }
  const revoked = await repository.revoke(client, new Date());
  console.log(revoked ? `revoked: ${client}` : `no active client: ${client}`);
  return revoked ? 0 : 1;
}

async function runCommand(
  repository: MikroOrmApiClientRepository,
  command: string | undefined,
  values: { name?: string; role?: string; provider?: string; client?: string },
): Promise<number> {
  if (command === 'create') {
    return handleCreate(repository, values);
  }
  if (command === 'revoke') {
    return handleRevoke(repository, values.client);
  }
  console.error(USAGE);
  return 2;
}

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
    return await runCommand(repository, positionals[0], values);
  } finally {
    await orm.close(true);
  }
}

process.exitCode = await main();
