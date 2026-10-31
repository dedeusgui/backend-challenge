# ADR 0007: API keys with two roles, and provider scope

**Status:** accepted. Supersedes [ADR 0006](0006-authentication-deferred.md).

## Context

ADR 0006 deferred authentication, and the challenge allows that. The owner now asks for a
simple, working scheme that lets the project do what it must: providers submit operations for
their own provider id, operators run the back office, and nobody else reaches the API. The
challenge suggests integrating an external identity provider (Keycloak or Zitadel) and warns
against hand-made authentication with a user table and password hashes.

## Decision

Each API client has one long-lived **bearer key**, sent as `Authorization: Bearer <key>`. A
client has one of two roles:

| Role       | Bound to         | May                                                                      |
| ---------- | ---------------- | ------------------------------------------------------------------------ |
| `PROVIDER` | one `providerId` | submit and read the operations of its own provider id                    |
| `OPERATOR` | no provider      | open, read and reconcile wallets, read metrics, and act for any provider |

- Health probes are public. Every other route needs a valid key.
- A PROVIDER request for another provider id is refused with `403 FORBIDDEN`, before anything
  is written. A transaction read by id that belongs to another provider is also `403`.
- The key is 256 random bits with the prefix `wgr_`. Only its SHA-256 hash is stored in
  `api_clients`. The hash is enough: the key cannot be searched from it, and a password hash
  would only slow down a lookup made on every request.
- A key is created and revoked with `bun run auth:create` and `bun run auth:revoke`. The key is
  printed once. A revoked client keeps its row, so an audit can still see it.
- The guard (`ApiKeyGuard`) authenticates each request once, before the controller runs.
  The controller checks provider scope, because only it knows the provider of the record.

The unused `ProviderIdentityPort` stub is removed. This guard replaces it.

## Alternatives

- **Keycloak or Zitadel, with OIDC.** The challenge's expectation, and the right choice for a
  real deployment. It adds a container with its own realm, clients and token lifetimes, and this
  build would still need a second service to test. The key table and the guard are the place
  where an OIDC verifier would replace the hash lookup, so the change stays local.
- **Signed JWTs issued locally.** Still needs an issuer, and gives no revocation without a
  list. Rejected.
- **A shared secret for everyone.** Gives no provider scope. Rejected.

## Consequences

- Keys do not expire, and rotation is manual: create a new client, then revoke the old one.
- Keys are sent in every request, so the API must run behind TLS in any real deployment. This
  build serves plain HTTP inside a trusted network, as before.
- Queue messages are still a trusted internal channel. The authenticator does not see them.
  Their provider and wallet fields are still checked in the domain.
- A leaked key lets its holder act for its provider until it is revoked. A revoked key is
  refused on the next request, with no cache to flush.

## Evidence

- `test/unit/auth/api-client.test.ts`: the role rules, key format, hash, bearer parsing, and
  the validation of `CreateApiClient`.
- `test/integration/auth/api-clients.test.ts`: only the hash is stored, a revoked key is refused,
  and the table refuses a PROVIDER without a provider and an OPERATOR with one. It also runs the
  `auth` command and checks the key it prints.
- `test/e2e/auth-http.test.ts`: 401 without, with unknown, or with revoked keys; 403 for a
  provider on operator routes, on another provider's submission and reads; 200 for the allowed
  cases; health public.
