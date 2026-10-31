/**
 * Future authentication boundary.
 *
 * An OIDC adapter may resolve the provider identity from a verified credential.
 * Until authentication is implemented, this port is intentionally not wired.
 */
export interface ProviderIdentityPort {
  resolveProviderId(authorizationHeader: string | undefined): Promise<string | null>;
}
