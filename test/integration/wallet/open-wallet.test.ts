import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WalletAlreadyExistsError } from '../../../src/shared/application/application-errors';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

const NOW = new Date('2026-07-29T15:00:00.000Z');

let database: TestDatabase;
let openWallet: OpenWallet;

beforeAll(async () => {
  database = await createTestDatabase();
  openWallet = new OpenWallet({
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => NOW,
    newId: randomUUID,
  });
});

afterAll(async () => {
  await database.drop();
});

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const rows = (await database.orm.em.getConnection().execute(sql, params)) as Array<{ n: string }>;
  return Number(rows[0]?.n ?? 0);
}

describe('OpenWallet', () => {
  test('a funded wallet is stored with its OPENING transaction, ledger credit and events in one commit', async () => {
    const playerId = `player-${randomUUID()}`;

    const opened = await openWallet.execute({ playerId, initialBalance: brl('1000.00') });

    expect(opened.balance.toString()).toBe('1000.00');
    expect(opened.version).toBe(1);
    const ledger = (await database.orm.em
      .getConnection()
      .execute(
        `SELECT direction, amount::text AS amount FROM wallet_ledger_entries WHERE wallet_id = ?`,
        [opened.walletId],
      )) as Array<{ direction: string; amount: string }>;
    expect(ledger).toEqual([{ direction: 'CREDIT', amount: '1000.00' }]);
    const opening = (await database.orm.em
      .getConnection()
      .execute(`SELECT kind, status FROM wager_transactions WHERE wallet_id = ?`, [
        opened.walletId,
      ])) as Array<{ kind: string; status: string }>;
    expect(opening).toEqual([{ kind: 'OPENING', status: 'PROCESSED' }]);
    const events = await countRows(
      `SELECT count(*)::text AS n FROM outbox_messages WHERE aggregate_id = ?`,
      [opened.walletId],
    );
    expect(events).toBe(1);
  });

  test('an empty wallet has no OPENING transaction and no ledger entry', async () => {
    const opened = await openWallet.execute({
      playerId: `player-${randomUUID()}`,
      initialBalance: brl('0.00'),
    });

    expect(
      await countRows(`SELECT count(*)::text AS n FROM wager_transactions WHERE wallet_id = ?`, [
        opened.walletId,
      ]),
    ).toBe(0);
    expect(
      await countRows(`SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ?`, [
        opened.walletId,
      ]),
    ).toBe(0);
  });

  test('a second wallet in the same currency for the same player is a conflict and leaves no rows behind', async () => {
    const playerId = `player-${randomUUID()}`;
    await openWallet.execute({ playerId, initialBalance: brl('10.00') });
    const walletsBefore = await countRows(
      `SELECT count(*)::text AS n FROM wallets WHERE player_id = ?`,
      [playerId],
    );
    const transactionsBefore = await countRows(
      `SELECT count(*)::text AS n FROM wager_transactions WHERE player_id = ?`,
      [playerId],
    );

    const attempt = openWallet.execute({ playerId, initialBalance: brl('20.00') });

    await expect(attempt).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    expect(
      await countRows(`SELECT count(*)::text AS n FROM wallets WHERE player_id = ?`, [playerId]),
    ).toBe(walletsBefore);
    expect(
      await countRows(`SELECT count(*)::text AS n FROM wager_transactions WHERE player_id = ?`, [
        playerId,
      ]),
    ).toBe(transactionsBefore);
  });
});
