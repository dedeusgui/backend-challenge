import type { Money } from '../../../shared/domain/money';
import type { WagerTransactionKind } from './wager-transaction-kind';
import { wagerPayloadHash, type WagerPayload } from './wager-payload-hash';

/** Hash of a payload built from business fields only, shared by every entry point. */
export function hashOf(fields: {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
}): string {
  const payload: WagerPayload = { ...fields };
  return wagerPayloadHash(payload);
}
