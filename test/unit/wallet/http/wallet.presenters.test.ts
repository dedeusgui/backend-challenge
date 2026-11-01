import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/shared/domain/money';
import { presentOpenedWallet } from '../../../../src/modules/wallet/http/wallet.presenters';

describe('presentOpenedWallet', () => {
  test('returns the opening contract with its nested balance', () => {
    expect(
      presentOpenedWallet(
        {
          walletId: 'wallet-1',
          balance: Money.from({ amount: '25.00', currency: 'BRL' }),
          version: 1,
        },
        'player-1',
      ),
    ).toEqual({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: { amount: '25.00', currency: 'BRL' },
      version: 1,
    });
  });
});
