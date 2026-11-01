import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../../src/shared/domain/money';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransaction } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

const NOW = new Date('2026-11-01T12:00:00.000Z');
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ verifyLedgerInvariant: false });
});

afterAll(async () => {
  await database.drop();
});

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

describe('wallet balance ledger constraint trigger', () => {
  test('rejects a balance update at commit when no ledger entry explains it', async () => {
    const unitOfWork = new MikroOrmFinancialUnitOfWork(database.orm);
    const { walletId } = await new OpenWallet({
      unitOfWork,
      clock: () => NOW,
      newId: randomUUID,
    }).execute({ playerId: `player-${randomUUID()}`, initialBalance: Money.zero('BRL') });

    let caught: unknown;
    try {
      await database.orm.em.fork().transactional(async (em) => {
        await em.execute('UPDATE wallets SET balance = 1.00, version = version + 1 WHERE id = ?', [
          walletId,
        ]);
      });
    } catch (error) {
      caught = error;
    }
    expect(sqlState(caught)).toBe('23514');
  });

  test('allows an empty zero balance wallet and normal wallet and wager flows', async () => {
    const unitOfWork = new MikroOrmFinancialUnitOfWork(database.orm);
    const openWallet = new OpenWallet({ unitOfWork, clock: () => NOW, newId: randomUUID });
    const empty = await openWallet.execute({
      playerId: `player-${randomUUID()}`,
      initialBalance: Money.zero('BRL'),
    });
    expect(empty.balance.toString()).toBe('0.00');

    const playerId = `player-${randomUUID()}`;
    const funds = await openWallet.execute({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const result = await new ProcessWagerTransaction({
      unitOfWork,
      clock: () => NOW,
      newId: randomUUID,
    }).execute({
      idempotencyKey: `provider-a:${randomUUID()}`,
      providerId: 'provider-a',
      externalTransactionId: `ext-${randomUUID()}`,
      playerId,
      walletId: funds.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      referenceExternalTransactionId: undefined,
      kind: 'BET',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      correlationId: 'test-correlation',
    });
    expect(result.transaction.status).toBe('PROCESSED');
  });
});
