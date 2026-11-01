import type { ApiClientRole, Principal } from '../../domain/principal';

export interface NewApiClient {
  id: string;
  name: string;
  role: ApiClientRole;
  providerId: string | undefined;
  keyHash: string;
  createdAt: Date;
}

export interface ApiClientRepository {
  insert(client: NewApiClient): Promise<void>;
  /** The principal of the client that holds this key hash, unless it has been revoked. */
  findActiveByKeyHash(keyHash: string): Promise<Principal | undefined>;
  /** Returns false when the client does not exist or is already revoked. */
  revoke(clientId: string, at: Date): Promise<boolean>;
}
