import { hashApiKey, parseBearerToken } from '../domain/api-key';
import type { Principal } from '../domain/principal';
import type { ApiClientRepository } from './ports/api-client-repository';

export class AuthenticateApiKey {
  constructor(private readonly clients: ApiClientRepository) {}

  /** The caller behind an Authorization header. Undefined when the header is missing, malformed, unknown or revoked. */
  async execute(authorization: string | undefined): Promise<Principal | undefined> {
    const token = parseBearerToken(authorization);
    return token === undefined ? undefined : this.clients.findActiveByKeyHash(hashApiKey(token));
  }
}
