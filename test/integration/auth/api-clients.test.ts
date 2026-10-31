import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { hashApiKey } from '../../../src/modules/auth/domain/api-key';
import { CreateApiClient } from '../../../src/modules/auth/application/create-api-client.use-case';
import { MikroOrmApiClientRepository } from '../../../src/modules/auth/infrastructure/mikro-orm-api-client.repository';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { required } from '../../support/required';

let database: TestDatabase;
let repository: MikroOrmApiClientRepository;
let create: CreateApiClient;

beforeAll(async () => {
  database = await createTestDatabase();
  repository = new MikroOrmApiClientRepository(database.orm);
  create = new CreateApiClient({ repository, clock: () => new Date(), newId: randomUUID });
});

afterAll(async () => {
  await database.drop();
});

async function rowsOf(
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  return (await database.orm.em.getConnection().execute(sql, params)) as Array<
    Record<string, unknown>
  >;
}

/** The SQLSTATE of the first failing statement, or NO_ERROR. */
async function sqlStateOf(sql: string, params: unknown[]): Promise<string> {
  try {
    await database.orm.em.getConnection().execute(sql, params);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `UNEXPECTED: ${String(error)}`;
  }
  return 'NO_ERROR';
}

describe('api_clients: storage and lookup', () => {
  test('a created client is found by the hash of its key, with its role and provider', async () => {
    const created = await create.execute({
      name: 'provider a',
      role: 'PROVIDER',
      providerId: 'provider-a',
    });

    expect(await repository.findActiveByKeyHash(hashApiKey(created.apiKey))).toEqual({
      clientId: created.clientId,
      name: 'provider a',
      role: 'PROVIDER',
      providerId: 'provider-a',
    });
  });

  test('no column of any row holds the plaintext key', async () => {
    const created = await create.execute({ name: 'ops', role: 'OPERATOR' });

    const rows = await rowsOf(`SELECT row_to_json(api_clients)::text AS row FROM api_clients`);

    expect(rows.some((row) => String(row.row).includes(created.apiKey))).toBe(false);
  });

  test('a revoked key is no longer accepted, and revoking twice changes nothing', async () => {
    const created = await create.execute({ name: 'retired', role: 'OPERATOR' });

    expect(await repository.revoke(created.clientId, new Date())).toBe(true);
    expect(await repository.findActiveByKeyHash(hashApiKey(created.apiKey))).toBeUndefined();
    expect(await repository.revoke(created.clientId, new Date())).toBe(false);
  });
});

describe('api_clients: constraints', () => {
  const insert = (role: string, providerId: string | null, keyHash: string) =>
    sqlStateOf(
      `INSERT INTO api_clients (id, name, role, provider_id, key_hash, created_at)
       VALUES (?, 'row', ?, ?, ?, now())`,
      [randomUUID(), role, providerId, keyHash],
    );

  test('a PROVIDER must name a provider, and an OPERATOR must not', async () => {
    expect(await insert('PROVIDER', null, randomUUID().replaceAll('-', '').padEnd(64, '0'))).toBe(
      '23514',
    );
    expect(
      await insert('OPERATOR', 'provider-a', randomUUID().replaceAll('-', '').padEnd(64, '1')),
    ).toBe('23514');
  });

  test('two clients cannot share a key hash, and the hash has the length of a SHA-256 hex digest', async () => {
    const hash = hashApiKey(`wgr_${randomUUID()}`);
    expect(await insert('OPERATOR', null, hash)).toBe('NO_ERROR');
    expect(await insert('OPERATOR', null, hash)).toBe('23505');
    expect(await insert('OPERATOR', null, 'short')).toBe('23514');
  });
});

describe('the auth command', () => {
  test('creates a client and prints its key once, and revokes it by id', async () => {
    const env = { ...process.env, DATABASE_URL: database.url };
    const created = Bun.spawn(
      [
        'bun',
        'run',
        'src/auth.ts',
        'create',
        '--name',
        'cli provider',
        '--role',
        'PROVIDER',
        '--provider',
        'provider-cli',
      ],
      { env, stdout: 'pipe', stderr: 'pipe', cwd: `${import.meta.dir}/../../..` },
    );
    const output = await new Response(created.stdout).text();
    expect(await created.exited).toBe(0);
    const clientId = /^client: (\S+)$/m.exec(output)?.[1];
    const apiKey = /^key: (\S+)$/m.exec(output)?.[1];
    expect(clientId).toBeDefined();
    expect(apiKey).toMatch(/^wgr_/);

    expect(
      await repository.findActiveByKeyHash(hashApiKey(required(apiKey, 'the API key'))),
    ).toMatchObject({
      role: 'PROVIDER',
      providerId: 'provider-cli',
    });

    const revoked = Bun.spawn(
      ['bun', 'run', 'src/auth.ts', 'revoke', '--client', required(clientId, 'the client id')],
      {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: `${import.meta.dir}/../../..`,
      },
    );
    expect(await revoked.exited).toBe(0);
    expect(
      await repository.findActiveByKeyHash(hashApiKey(required(apiKey, 'the API key'))),
    ).toBeUndefined();
  }, 60_000);
});
