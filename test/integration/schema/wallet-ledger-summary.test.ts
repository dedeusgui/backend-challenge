import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { WalletQueries } from '../../../src/modules/wallet/application/wallet-queries';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * The view wallet_ledger_summary (migration 11) and the reconciliation of the application compute the same
 * figures by two different routes: SQL over the rows, and TypeScript over the entries. A divergence found by one
 * must be found by the other, and with the same value. The workload runs through the real use cases.
 */

const NOW = new Date('2026-07-29T15:00:00.000Z');

let database: TestDatabase;
let openWallet: OpenWallet;
let processWager: ProcessWagerTransaction;
let queries: WalletQueries;

beforeAll(async () => {
  database = await createTestDatabase({ verifyLedgerInvariant: false });
  const dependencies = {
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => NOW,
    newId: randomUUID,
  };
  openWallet = new OpenWallet(dependencies);
  processWager = new ProcessWagerTransaction(dependencies);
  queries = new WalletQueries(dependencies);
});

afterAll(async () => {
  await database.drop();
});

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

async function viewRow(walletId: string) {
  const rows = (await database.orm.em.getConnection().execute(
    `SELECT stored_balance::text AS stored, calculated_balance::text AS calculated,
            difference::text AS difference, entries::int AS entries
       FROM wallet_ledger_summary WHERE wallet_id = ?`,
    [walletId],
  )) as Array<{ stored: string; calculated: string; difference: string; entries: number }>;
  return rows[0];
}

function operation(
  walletId: string,
  playerId: string,
  kind: ProcessWagerCommand['kind'],
  amount: string,
  reference?: string,
): ProcessWagerCommand {
  const externalTransactionId = `${kind.toLowerCase()}-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: reference,
    correlationId: externalTransactionId,
  };
}

describe('the ledger summary view agrees with the reconciliation of the application', () => {
  test('a wallet with a mixed history: the view and the reconciliation give the same figures', async () => {
    const playerId = `player-${randomUUID()}`;
    const { walletId } = await openWallet.execute({ playerId, initialBalance: brl('100.00') });
    const bet = operation(walletId, playerId, 'BET', '30.00');
    await processWager.execute(bet);
    await processWager.execute(
      operation(walletId, playerId, 'WIN', '50.00', bet.externalTransactionId),
    );
    const refundedBet = operation(walletId, playerId, 'BET', '10.00');
    await processWager.execute(refundedBet);
    await processWager.execute(
      operation(walletId, playerId, 'REFUND', '10.00', refundedBet.externalTransactionId),
    );

    const report = await queries.reconcile(walletId);
    const row = await viewRow(walletId);

    expect(row).toEqual({
      stored: report.storedBalance.toString(),
      calculated: report.calculatedBalance.toString(),
      difference: report.difference.toString(),
      entries: report.checkedEntries,
    });
    expect(row?.difference).toBe('0.00');
  });

  test('a divergence made with the version moved along is reported by both, with the same value', async () => {
    const playerId = `player-${randomUUID()}`;
    const { walletId } = await openWallet.execute({ playerId, initialBalance: brl('100.00') });
    await database.orm.em.fork().transactional(async (em) => {
      // This suite deliberately creates a corrupt row to prove the read model reports it.
      await em.execute('ALTER TABLE wallets DISABLE TRIGGER wallets_ledger_balance_check');
      await em.execute(
        `UPDATE wallets SET balance = balance + 7.00, version = version + 1 WHERE id = ?`,
        [walletId],
      );
      await em.execute('ALTER TABLE wallets ENABLE TRIGGER wallets_ledger_balance_check');
    });

    const report = await queries.reconcile(walletId);
    const row = await viewRow(walletId);

    expect(report.consistent).toBe(false);
    expect(report.difference.toString()).toBe('7.00');
    expect(row?.difference).toBe('7.00');
  });

  test('a wallet with no entries is zero in both', async () => {
    const id = randomUUID();
    await database.orm.em.getConnection().execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', 0.00, 1, now(), now())`,
      [id, `player-${randomUUID()}`],
    );

    const row = await viewRow(id);

    expect(row).toEqual({ stored: '0.00', calculated: '0.00', difference: '0.00', entries: 0 });
  });
});
