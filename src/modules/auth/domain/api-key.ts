import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'wgr_';
const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/;

/**
 * A new key: 256 random bits, with a prefix so that a leaked key is easy to find in logs and
 * repositories. The key is shown once. Only its hash is stored.
 */
export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * SHA-256 is enough for 256-bit random keys: an attacker cannot search the key space from the
 * hash. A password hash would only slow down a lookup that happens on every request.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The token of an `Authorization: Bearer <token>` header, or undefined for any other header. */
export function parseBearerToken(authorization: string | undefined): string | undefined {
  return BEARER.exec(authorization ?? '')?.[1];
}
