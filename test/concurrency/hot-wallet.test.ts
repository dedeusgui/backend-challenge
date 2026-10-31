import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../src/modules/wallet/application/open-wallet.use-case';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
  type ProcessWagerOutcome,
} from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';

/**
 * Real concurrency: every call below opens its own PostgreSQL connection and
 * transaction, and all of them are in flight at the same time. Nothing here
 * awaits one operation before starting the next.
 */

const NOW = new Date('2026-07-29T15:00:00.000Z');

let database: TestDatabase;
let processWager: ProcessWagerTransaction;
let openWallet: OpenWallet;

beforeAll(async () => {
  database = await createTestDatabase();
  const dependencies = {
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => NOW,
    newId: randomUUID,
  };
  processWager = new ProcessWagerTransaction(dependencies);
  openWallet = new OpenWallet(dependencies);
});

afterAll(async () => {
  await database.drop();
});

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

async function openedWallet(
  initialBalance: string,
): Promise<{ walletId: string; playerId: string }> {
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({ playerId, initialBalance: brl(initialBalance) });
  return { walletId, playerId };
}

function commandFor(
  wallet: { walletId: string; playerId: string },
  kind: ProcessWagerCommand['kind'],
  amount: string,
  overrides: Partial<ProcessWagerCommand> = {},
): ProcessWagerCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `transaction-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: undefined,
    correlationId: `corr-${randomUUID()}`,
    ...overrides,
  };
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [walletId])) as Array<{
    balance: string;
  }>;
  return rows[0]?.balance ?? '';
}

/** Sum of CREDIT minus DEBIT in the ledger. The final invariant compares it with the materialized balance. */
async function ledgerBalanceOf(walletId: string): Promise<string> {
  const rows = (await database.orm.em.getConnection().execute(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS total
     FROM wallet_ledger_entries WHERE wallet_id = ?`,
    [walletId],
  )) as Array<{ total: string }>;
  return rows[0]?.total ?? '';
}

async function debitCount(walletId: string): Promise<number> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(
      `SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
      [walletId],
    )) as Array<{ n: string }>;
  return Number(rows[0]?.n ?? 0);
}

describe('hot wallet: two bets racing for the same balance', () => {
  test('exactly one BET of 80.00 is processed, the other is rejected, and the balance ends at 20.00', async () => {
    const wallet = await openedWallet('100.00');

    const outcomes = await Promise.all([
      processWager.execute(commandFor(wallet, 'BET', '80.00')),
      processWager.execute(commandFor(wallet, 'BET', '80.00')),
    ]);

    expect(outcomes.map((outcome) => outcome.transaction.status).sort()).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);
    const rejected = outcomes.find((outcome) => outcome.transaction.status === 'REJECTED');
    expect(rejected?.transaction.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(await balanceOf(wallet.walletId)).toBe('20.00');
    expect(await debitCount(wallet.walletId)).toBe(1);
    expect(await ledgerBalanceOf(wallet.walletId)).toBe('20.00');
  });
});

describe('50 identical requests in parallel', () => {
  test('one debit is applied, and every other request replays the same transaction', async () => {
    const wallet = await openedWallet('100.00');
    const bet = commandFor(wallet, 'BET', '25.00', { externalTransactionId: 'same-bet' });

    const outcomes: ProcessWagerOutcome[] = await Promise.all(
      Array.from({ length: 50 }, () => processWager.execute(bet)),
    );

    const transactionIds = new Set(outcomes.map((outcome) => outcome.transaction.id));
    expect(transactionIds.size).toBe(1);
    expect(outcomes.filter((outcome) => !outcome.idempotentReplay)).toHaveLength(1);
    expect(outcomes.every((outcome) => outcome.transaction.status === 'PROCESSED')).toBe(true);
    expect(await balanceOf(wallet.walletId)).toBe('75.00');
    expect(await debitCount(wallet.walletId)).toBe(1);
  });
});

describe('distinct wallets in parallel', () => {
  test('operations on different wallets all succeed and each wallet stays consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openedWallet('100.00')));

    const outcomes = await Promise.all(
      wallets.map((wallet) => processWager.execute(commandFor(wallet, 'BET', '30.00'))),
    );

    expect(outcomes.every((outcome) => outcome.transaction.status === 'PROCESSED')).toBe(true);
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.walletId)).toBe('70.00');
      expect(await ledgerBalanceOf(wallet.walletId)).toBe('70.00');
    }
  });
});

describe('mixed operations on one hot wallet', () => {
  test('the materialized balance always equals the ledger sum, and never goes negative', async () => {
    const wallet = await openedWallet('50.00');
    const operations: Array<Promise<ProcessWagerOutcome>> = [];
    for (let index = 0; index < 40; index += 1) {
      operations.push(
        processWager.execute(
          index % 3 === 0 ? commandFor(wallet, 'WIN', '4.00') : commandFor(wallet, 'BET', '7.00'),
        ),
      );
    }

    const outcomes = await Promise.all(operations);

    const balance = await balanceOf(wallet.walletId);
    expect(balance.startsWith('-')).toBe(false);
    expect(await ledgerBalanceOf(wallet.walletId)).toBe(balance);
    expect(
      outcomes.some((outcome) => outcome.transaction.failureCode === 'INSUFFICIENT_BALANCE'),
    ).toBe(true);
  });
});

describe('competing reversals of the same bet', () => {
  test('two different-key refunds of one bet produce exactly one reversal', async () => {
    const wallet = await openedWallet('100.00');
    await processWager.execute(
      commandFor(wallet, 'BET', '25.00', { externalTransactionId: 'bet-race' }),
    );

    const refunds = await Promise.all([
      processWager.execute(
        commandFor(wallet, 'REFUND', '25.00', { referenceExternalTransactionId: 'bet-race' }),
      ),
      processWager.execute(
        commandFor(wallet, 'REFUND', '25.00', { referenceExternalTransactionId: 'bet-race' }),
      ),
    ]);

    expect(refunds.map((outcome) => outcome.transaction.status).sort()).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    expect(await ledgerBalanceOf(wallet.walletId)).toBe('100.00');
  });
});
