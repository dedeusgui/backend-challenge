import { describe, expect, test } from 'bun:test';
import { parseWagerCommandMessage } from '../../../../src/modules/messaging/application/wager-command-message';
import { RequestValidationError } from '../../../../src/shared/validation/request-validation';

const VALID_WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

function messageWith(data: Record<string, unknown>): string {
  return JSON.stringify({
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: 'player-1',
      walletId: VALID_WALLET_ID,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...data,
    },
  });
}

describe('parseWagerCommandMessage', () => {
  test('maps a valid message to the command the HTTP endpoint builds', () => {
    const command = parseWagerCommandMessage(messageWith({}), 'wager-transactions');

    expect(command).toMatchObject({
      providerId: 'provider-a',
      walletId: VALID_WALLET_ID,
      kind: 'BET',
      inbound: { consumerName: 'wager-transactions', messageId: 'msg-123' },
    });
  });

  test('refuses a wallet id that is not a UUID, as the HTTP endpoint does, before PostgreSQL sees it', () => {
    expect(() =>
      parseWagerCommandMessage(messageWith({ walletId: 'not-a-uuid' }), 'wager-transactions'),
    ).toThrow(RequestValidationError);
  });

  test('refuses an idempotency key with a control character', () => {
    expect(() =>
      parseWagerCommandMessage(
        messageWith({ idempotencyKey: 'provider-a:transaction\t123' }),
        'wager-transactions',
      ),
    ).toThrow(RequestValidationError);
  });
});
