import { DomainError } from '../../../shared/domain/domain-error';
import { hashApiKey, generateApiKey } from '../domain/api-key';
import type { ApiClientRole } from '../domain/principal';
import type { ApiClientRepository } from './ports/api-client-repository';

export interface CreateApiClientInput {
  name: string;
  role: ApiClientRole;
  providerId?: string;
}

export interface CreatedApiClient {
  clientId: string;
  /** Returned once. It is not stored, and cannot be shown again. */
  apiKey: string;
}

export interface CreateApiClientDependencies {
  repository: ApiClientRepository;
  clock: () => Date;
  newId: () => string;
}

/** Creates a client and its key. Only the hash of the key reaches the repository. */
export class CreateApiClient {
  constructor(private readonly dependencies: CreateApiClientDependencies) {}

  async execute(input: CreateApiClientInput): Promise<CreatedApiClient> {
    const name = input.name.trim();
    const providerId = input.providerId?.trim();
    if (name === '') {
      throw new DomainError('INVALID_API_CLIENT', 'A client needs a name');
    }
    if (input.role === 'PROVIDER' && (providerId === undefined || providerId === '')) {
      throw new DomainError('INVALID_API_CLIENT', 'A PROVIDER client must name its provider');
    }
    if (input.role === 'OPERATOR' && providerId !== undefined) {
      throw new DomainError('INVALID_API_CLIENT', 'An OPERATOR client is not bound to a provider');
    }

    const apiKey = generateApiKey();
    const clientId = this.dependencies.newId();
    await this.dependencies.repository.insert({
      id: clientId,
      name,
      role: input.role,
      providerId: input.role === 'PROVIDER' ? providerId : undefined,
      keyHash: hashApiKey(apiKey),
      createdAt: this.dependencies.clock(),
    });
    return { clientId, apiKey };
  }
}
