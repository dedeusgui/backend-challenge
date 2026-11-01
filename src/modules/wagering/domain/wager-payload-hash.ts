import { createHash } from 'node:crypto';
import type { Money } from '../../../shared/domain/money';
import type { WagerTransactionKind } from './wager-transaction-kind';

/**
 * The business fields that define a transaction's payload. Transport metadata
 * such as the Idempotency-Key header or the SQS messageId is deliberately absent.
 */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
}

type CanonicalValue = string | null | { readonly [key: string]: CanonicalValue };

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit at every level, no
 * whitespace, and an absent reference encoded as null. This is the contract for
 * payloadHash; changing it invalidates stored hashes.
 */
function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === 'string') {
    return JSON.stringify(value);
  }
  const members = Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${members.join(',')}}`;
}

function moneyFields(money: Money): { amount: string; currency: string } {
  const { amount, currency } = money.toJSON();
  return { amount, currency };
}

type CanonicalRecord = { readonly [key: string]: CanonicalValue };

function canonicalFieldsOf(payload: WagerPayload): CanonicalRecord {
  return {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: moneyFields(payload.money),
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  };
}

export function canonicalWagerPayload(payload: WagerPayload): string {
  return canonicalJson(canonicalFieldsOf(payload));
}

/**
 * Fingerprint of one queue message: the business payload plus the idempotencyKey it carries. A queue
 * message is identified by its messageId, so a change of its key is a change of its content. The
 * key is not part of payloadHash, because for a transaction the key is the identity itself.
 */
export function wagerMessageFingerprint(payload: WagerPayload, idempotencyKey: string): string {
  const canonical = canonicalJson({ ...canonicalFieldsOf(payload), idempotencyKey });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** SHA-256 of the canonical payload, as lowercase hex. */
export function wagerPayloadHash(payload: WagerPayload): string {
  return createHash('sha256').update(canonicalWagerPayload(payload), 'utf8').digest('hex');
}
