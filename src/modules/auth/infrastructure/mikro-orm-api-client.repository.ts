import type { MikroORM } from '@mikro-orm/postgresql';
import type { ApiClientRepository, NewApiClient } from '../application/api-client-repository.port';
import { API_CLIENT_ROLES, type Principal } from '../domain/principal';
import { ApiClientRecord } from './api-client.record';

/** Each call uses its own fork, so that a request never sees another request's identity map. */
export class MikroOrmApiClientRepository implements ApiClientRepository {
  constructor(private readonly orm: MikroORM) {}

  async insert(client: NewApiClient): Promise<void> {
    await this.orm.em.fork().insert(ApiClientRecord, {
      id: client.id,
      name: client.name,
      role: client.role,
      providerId: client.providerId ?? null,
      keyHash: client.keyHash,
      createdAt: client.createdAt,
      revokedAt: null,
    });
  }

  async findActiveByKeyHash(keyHash: string): Promise<Principal | undefined> {
    const record = await this.orm.em
      .fork()
      .findOne(ApiClientRecord, { keyHash, revokedAt: null }, { refresh: true });
    return record === null ? undefined : toPrincipal(record);
  }

  async revoke(clientId: string, at: Date): Promise<boolean> {
    const updated = await this.orm.em
      .fork()
      .nativeUpdate(ApiClientRecord, { id: clientId, revokedAt: null }, { revokedAt: at });
    return updated === 1;
  }
}

function toPrincipal(record: ApiClientRecord): Principal {
  const role = API_CLIENT_ROLES.find((candidate) => candidate === record.role);
  if (role === undefined) {
    throw new Error(`API client ${record.id} is stored with an unknown role`);
  }
  const principal = { clientId: record.id, name: record.name, role };
  return record.providerId === null ? principal : { ...principal, providerId: record.providerId };
}
