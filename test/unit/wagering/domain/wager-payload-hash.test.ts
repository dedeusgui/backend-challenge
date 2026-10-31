import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Money } from '../../../../src/shared/domain/money';
import {
  canonicalWagerPayload,
  wagerPayloadHash,
  type WagerPayload,
} from '../../../../src/modules/wagering/domain/wager-payload-hash';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function samplePayload(overrides: Partial<WagerPayload> = {}): WagerPayload {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    ...overrides,
  };
}

/**
 * The contract for the canonical form. Keys are sorted at every level, there is
 * no whitespace, and a missing reference is encoded as null.
 */
const GOLDEN_CANONICAL_FORM =
  '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
  '"money":{"amount":"25.00","currency":"BRL"},' +
  '"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a",' +
  '"referenceExternalTransactionId":null,"roundId":"round-987",' +
  '"walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

describe('wagerPayloadHash canonical form', () => {
  test('encodes the business fields with sorted keys and no whitespace', () => {
    expect(canonicalWagerPayload(samplePayload())).toBe(GOLDEN_CANONICAL_FORM);
  });

  test('is the SHA-256 digest of the canonical form, as lowercase hex', () => {
    const expected = createHash('sha256').update(GOLDEN_CANONICAL_FORM).digest('hex');
    expect(wagerPayloadHash(samplePayload())).toBe(expected);
    expect(wagerPayloadHash(samplePayload())).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not depend on the order in which fields were assembled', () => {
    const sample = samplePayload();
    const reversed: WagerPayload = {
      walletId: sample.walletId,
      roundId: sample.roundId,
      money: sample.money,
      kind: sample.kind,
      gameId: sample.gameId,
      referenceExternalTransactionId: sample.referenceExternalTransactionId,
      playerId: sample.playerId,
      providerId: sample.providerId,
      externalTransactionId: sample.externalTransactionId,
    };

    expect(wagerPayloadHash(reversed)).toBe(wagerPayloadHash(sample));
  });

  test('an absent reference and an explicit undefined reference hash identically', () => {
    const absent = samplePayload({ referenceExternalTransactionId: undefined });
    expect(wagerPayloadHash(absent)).toBe(wagerPayloadHash(samplePayload()));
  });
});

describe('wagerPayloadHash sensitivity', () => {
  test.each([
    ['external transaction id', { externalTransactionId: 'transaction-124' }],
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2' }],
    ['wallet', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['round', { roundId: 'round-988' }],
    ['game', { gameId: 'other-game' }],
    ['kind', { kind: 'WIN' as const }],
    ['amount', { money: brl('25.01') }],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['reference added', { referenceExternalTransactionId: 'bet-1' }],
  ])('changing the %s changes the hash', (_label, override) => {
    expect(wagerPayloadHash(samplePayload(override))).not.toBe(wagerPayloadHash(samplePayload()));
  });
});
