import { describe, expect, test } from 'bun:test';
import {
  generateApiKey,
  hashApiKey,
  parseBearerToken,
} from '../../../src/modules/auth/domain/api-key';
import {
  canOperateFor,
  isOperator,
  type Principal,
} from '../../../src/modules/auth/domain/principal';
import { CreateApiClient } from '../../../src/modules/auth/application/create-api-client.use-case';
import type {
  ApiClientRepository,
  NewApiClient,
} from '../../../src/modules/auth/application/ports/api-client-repository';
import { DomainError } from '../../../src/shared/domain/domain-error';

const NOW = new Date('2026-07-29T15:00:00.000Z');

const operator: Principal = { clientId: 'client-ops', name: 'operations', role: 'OPERATOR' };
const providerA: Principal = {
  clientId: 'client-a',
  name: 'provider a',
  role: 'PROVIDER',
  providerId: 'provider-a',
};

describe('principal rules', () => {
  test('an operator may act for any provider', () => {
    expect(canOperateFor(operator, 'provider-a')).toBe(true);
    expect(canOperateFor(operator, 'provider-b')).toBe(true);
    expect(isOperator(operator)).toBe(true);
  });

  test('a provider may act only for its own provider id', () => {
    expect(canOperateFor(providerA, 'provider-a')).toBe(true);
    expect(canOperateFor(providerA, 'provider-b')).toBe(false);
    expect(isOperator(providerA)).toBe(false);
  });
});

describe('API keys', () => {
  test('every generated key is prefixed, long, and different from the last', () => {
    const first = generateApiKey();
    const second = generateApiKey();

    expect(first.startsWith('wgr_')).toBe(true);
    expect(first.length).toBeGreaterThanOrEqual(40);
    expect(first).not.toBe(second);
  });

  test('the stored form is a SHA-256 hex digest, stable for a key and different from it', () => {
    const key = 'wgr_example-key';
    const hash = hashApiKey(key);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key);
    expect(hashApiKey(key)).toBe(hash);
  });

  test.each([
    [undefined, undefined],
    ['', undefined],
    ['Basic abc', undefined],
    ['Bearer ', undefined],
    ['Bearer abc', 'abc'],
    ['Bearer wgr_AbC-123', 'wgr_AbC-123'],
  ] as const)('the bearer token of %p is %p', (header, token) => {
    expect(parseBearerToken(header)).toBe(token);
  });
});

function repositoryFake(): ApiClientRepository & { inserted: NewApiClient[] } {
  const inserted: NewApiClient[] = [];
  return {
    inserted,
    insert: async (client: NewApiClient) => {
      inserted.push(client);
    },
    findActiveByKeyHash: async () => undefined,
    revoke: async () => false,
  };
}

function domainErrorCodeOf(action: () => Promise<unknown>): Promise<string> {
  return action().then(
    () => 'NO_ERROR',
    (error: unknown) =>
      error instanceof DomainError ? error.code : `UNEXPECTED: ${String(error)}`,
  );
}

describe('CreateApiClient', () => {
  test('returns the key once, and stores only its hash', async () => {
    const repository = repositoryFake();
    const create = new CreateApiClient({ repository, clock: () => NOW, newId: () => 'client-1' });

    const created = await create.execute({
      name: 'provider a',
      role: 'PROVIDER',
      providerId: 'provider-a',
    });

    expect(created).toEqual({ clientId: 'client-1', apiKey: expect.stringMatching(/^wgr_/) });
    const stored = repository.inserted[0];
    expect(stored?.keyHash).toBe(hashApiKey(created.apiKey));
    expect(JSON.stringify(stored)).not.toContain(created.apiKey);
  });

  test('a PROVIDER client must name its provider, and an OPERATOR client must not', async () => {
    const create = new CreateApiClient({
      repository: repositoryFake(),
      clock: () => NOW,
      newId: () => 'client-1',
    });

    expect(await domainErrorCodeOf(() => create.execute({ name: 'p', role: 'PROVIDER' }))).toBe(
      'INVALID_API_CLIENT',
    );
    expect(
      await domainErrorCodeOf(() =>
        create.execute({ name: 'ops', role: 'OPERATOR', providerId: 'provider-a' }),
      ),
    ).toBe('INVALID_API_CLIENT');
  });

  test('a client needs a name', async () => {
    const create = new CreateApiClient({
      repository: repositoryFake(),
      clock: () => NOW,
      newId: () => 'client-1',
    });

    expect(await domainErrorCodeOf(() => create.execute({ name: '  ', role: 'OPERATOR' }))).toBe(
      'INVALID_API_CLIENT',
    );
  });
});
