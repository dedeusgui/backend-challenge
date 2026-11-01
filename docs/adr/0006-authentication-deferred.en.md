# ADR 0006: Authentication deferred, with an explicit extension point

> English reference copy. The main version, in Portuguese, is [0006-authentication-deferred.md](0006-authentication-deferred.md).

**Status:** superseded by [ADR 0007](0007-api-key-authentication.en.md)

> **Note:** this decision was superseded by ADR 0007. The extension point named below, `ProviderIdentityPort`, does not exist in the current code; the authentication that is implemented is the one in ADR 0007. The text below is kept as a historical record.

## Context

The challenge assigns no points to authentication and allows it to be documented
as omitted (challenge §2).

## Decision

No authentication is implemented. The endpoints are open, and the readiness and
liveness probes are public. The extension point is
`src/shared/application/ports/provider-identity.port.ts` (`ProviderIdentityPort`).
A real deployment would add an OIDC guard against an external identity provider
(Keycloak or Zitadel) that resolves the caller's provider id. Every operation would
then check that the resolved provider matches `providerId`. No local user table or
password is stored.

Messages from the queue are treated as a trusted internal channel. Their business
fields are still validated: provider and wallet compatibility is checked in the
domain, whatever the transport.

## Consequences

- The HTTP API must not be exposed outside a trusted network.
- A provider could submit operations for another provider's id in this build. That
  is the most important risk, and it is listed in ARCHITECTURE §14.
