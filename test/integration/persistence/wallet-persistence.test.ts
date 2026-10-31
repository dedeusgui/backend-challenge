import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../../src/shared/domain/money';
import { ConcurrencyConflictError } from '../../../src/shared/application/application-errors';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { WagerTransaction } from '../../../src/modules/wagering/domain/wager-transaction';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

const OPENED_AT = new Date('2026-07-29T15:00:00.000Z');
const MOVED_AT = new Date('2026-07-29T15:00:05.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

let database: TestDatabase;
let unitOfWork: MikroOrmFinancialUnitOfWork;

beforeAll(async () => {
  database = await createTestDatabase();
  unitOfWork = new MikroOrmFinancialUnitOfWork(database.orm);
});

afterAll(async () => {
  await database.drop();
});

/** Opens a wallet with `initial` inside one transaction, including its OPENING transaction and entry. */
async function openWallet(initial: string): Promise<string> {
  const walletId = randomUUID();
  const openingTransactionId = randomUUID();
  const { wallet, openingEntry } = Wallet.open({
    walletId,
    playerId: `player-${randomUUID()}`,
    initialBalance: brl(initial),
    openingTransactionId,
    openingEntryId: randomUUID(),
    openedAt: OPENED_AT,
  });
  const opening = WagerTransaction.create({
    id: openingTransactionId,
    providerId: 'system',
    externalTransactionId: `opening-${walletId}`,
    idempotencyKey: `opening-${walletId}`,
    payloadHash: '0'.repeat(64),
    walletId,
    playerId: wallet.playerId,
    roundId: 'opening',
    gameId: 'opening',
    kind: 'OPENING',
    money: brl(initial),
    referenceExternalTransactionId: undefined,
    createdAt: OPENED_AT,
  });
  opening.markProcessed({
    referenceTransactionId: undefined,
    resultingBalance: brl(initial),
    at: OPENED_AT,
  });

  await unitOfWork.run(async (repositories) => {
    await repositories.wallets.insert(wallet);
    await repositories.wagers.insert(opening);
    if (openingEntry) {
      await repositories.ledger.append(openingEntry);
    }
  });
  return walletId;
}

/** Inserts a PROCESSED BET for `walletId` so that a debit entry has a transaction to reference. */
function processedBet(walletId: string, playerId: string, amount: string): WagerTransaction {
  const bet = WagerTransaction.create({
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: `bet-${randomUUID()}`,
    idempotencyKey: `key-${randomUUID()}`,
    payloadHash: 'a'.repeat(64),
    walletId,
    playerId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl(amount),
    referenceExternalTransactionId: undefined,
    createdAt: MOVED_AT,
  });
  return bet;
}

describe('wallet persistence', () => {
  test('reads back an opened wallet with its exact balance, version and ledger entry', async () => {
    const walletId = await openWallet('1000.00');

    await unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.findById(walletId);
      const entries = await repositories.ledger.listByWallet(walletId);

      expect(wallet?.balance.toString()).toBe('1000.00');
      expect(wallet?.version).toBe(1);
      expect(wallet?.currency).toBe('BRL');
      expect(entries.map((entry) => [entry.direction, entry.balanceAfter.toString()])).toEqual([
        ['CREDIT', '1000.00'],
      ]);
    });
  });

  test('a failed unit of work leaves no partial rows behind', async () => {
    const walletId = randomUUID();
    const attempt = unitOfWork.run(async (repositories) => {
      const { wallet } = Wallet.open({
        walletId,
        playerId: `player-${randomUUID()}`,
        initialBalance: brl('0.00'),
        openingTransactionId: randomUUID(),
        openingEntryId: randomUUID(),
        openedAt: OPENED_AT,
      });
      await repositories.wallets.insert(wallet);
      throw new Error('crash after the wallet insert but before commit');
    });

    await expect(attempt).rejects.toThrow('crash after the wallet insert');
    const found = await unitOfWork.run((repositories) => repositories.wallets.findById(walletId));
    expect(found).toBeUndefined();
  });

  test('saves a debit when the version still matches, bumping it once', async () => {
    const walletId = await openWallet('100.00');

    await unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.findForUpdate(walletId);
      if (!wallet) throw new Error('wallet must exist');
      const bet = processedBet(walletId, wallet.playerId, '80.00');
      bet.markProcessed({
        referenceTransactionId: undefined,
        resultingBalance: brl('20.00'),
        at: MOVED_AT,
      });
      const expectedVersion = wallet.version;
      const entry = wallet.debit({
        entryId: randomUUID(),
        transactionId: bet.id,
        money: brl('80.00'),
        at: MOVED_AT,
      });

      await repositories.wagers.insert(bet);
      await repositories.wallets.save(wallet, expectedVersion);
      await repositories.ledger.append(entry);
    });

    await unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.findById(walletId);
      expect(wallet?.balance.toString()).toBe('20.00');
      expect(wallet?.version).toBe(2);
    });
  });

  test('refuses a save whose expected version is stale, instead of overwriting', async () => {
    const walletId = await openWallet('100.00');
    const staleCopy = await unitOfWork.run((repositories) =>
      repositories.wallets.findById(walletId),
    );
    if (!staleCopy) throw new Error('wallet must exist');
    await unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.findForUpdate(walletId);
      if (!wallet) throw new Error('wallet must exist');
      const bet = processedBet(walletId, wallet.playerId, '10.00');
      bet.markProcessed({
        referenceTransactionId: undefined,
        resultingBalance: brl('90.00'),
        at: MOVED_AT,
      });
      const entry = wallet.debit({
        entryId: randomUUID(),
        transactionId: bet.id,
        money: brl('10.00'),
        at: MOVED_AT,
      });
      await repositories.wagers.insert(bet);
      await repositories.wallets.save(wallet, 1);
      await repositories.ledger.append(entry);
    });

    const attempt = unitOfWork.run(async (repositories) => {
      await repositories.wallets.save(staleCopy, 1);
    });
    await expect(attempt).rejects.toBeInstanceOf(ConcurrencyConflictError);

    await unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.findById(walletId);
      expect(wallet?.balance.toString()).toBe('90.00');
      expect(wallet?.version).toBe(2);
    });
  });
});

describe('a stored amount is read back as a Money with two decimals', () => {
  test('PostgreSQL returns a NUMERIC(20,2) value with two fractional digits, whatever it was given', async () => {
    // The read path relies on this: a driver never returns "25" for a NUMERIC(20,2) column.
    const rows = (await database.orm.em
      .getConnection()
      .execute(`SELECT '25'::numeric(20,2)::text AS amount`)) as Array<{ amount: string }>;
    expect(rows[0]?.amount).toBe('25.00');
  });

  test('a wallet stored with 25.00 is read back as the same Money', async () => {
    const walletId = await openWallet('25.00');

    const wallet = await unitOfWork.run((repositories) => repositories.wallets.findById(walletId));

    expect(wallet?.balance.toString()).toBe('25.00');
    expect(wallet?.balance.equals(brl('25.00'))).toBe(true);
  });
});
