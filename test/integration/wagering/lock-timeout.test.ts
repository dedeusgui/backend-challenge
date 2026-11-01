import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * A wallet row held by another transaction must not hold a bet indefinitely: the unit of
 * work caps the wait for the lock, fails fast with SQLSTATE 55P03, and leaves no partial effect.
 */

const NOW = new Date('2026-07-29T15:00:00.000Z');
const LOCK_TIMEOUT_MS = 200;

type Attempt =
  { succeeded: true; elapsedMs: number } | { succeeded: false; error: unknown; elapsedMs: number };

let database: TestDatabase;
let walletId: string;
let playerId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  const openWallet = new OpenWallet({
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => NOW,
    newId: randomUUID,
  });
  playerId = `player-${randomUUID()}`;
  const wallet = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  walletId = wallet.walletId;
});

afterAll(async () => {
  await database.drop();
});

function betCommand(): ProcessWagerCommand {
  const id = `tx-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${id}`,
    providerId: 'provider-a',
    externalTransactionId: id,
    playerId,
    walletId,
    roundId: `round-${id}`,
    gameId: 'game-1',
    kind: 'BET',
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    correlationId: `corr-${id}`,
  };
}

/** Reads SQLSTATE from a driver error without casting it. */
function sqlStateOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** Holds the wallet row lock in another transaction until `release` is called. */
async function holdWalletLock(): Promise<{ release: () => void; done: Promise<void> }> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markLocked: () => void = () => {};
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const done = database.orm.em.fork().transactional(async (em) => {
    await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [walletId]);
    markLocked();
    await gate;
  });
  await locked;
  return { release, done };
}

describe('wallet lock wait is bounded', () => {
  test('a bet waiting on a held wallet lock fails fast with 55P03 and no partial effect', async () => {
    const hold = await holdWalletLock();
    const processing = new ProcessWagerTransaction({
      unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm, { lockTimeoutMs: LOCK_TIMEOUT_MS }),
      clock: () => NOW,
      newId: randomUUID,
    });

    const startedAt = Date.now();
    const attempt = processing.execute(betCommand()).then(
      (): Attempt => ({ succeeded: true, elapsedMs: Date.now() - startedAt }),
      (error: unknown): Attempt => ({ succeeded: false, error, elapsedMs: Date.now() - startedAt }),
    );

    await Bun.sleep(1_000);
    hold.release();
    const result = await attempt;
    await hold.done;

    if (result.succeeded) {
      throw new Error('a bet on a locked wallet must not succeed while the lock is held');
    }
    expect(sqlStateOf(result.error)).toBe('55P03');
    expect(result.elapsedMs).toBeLessThan(3_000);

    const rows = (await database.orm.em
      .getConnection()
      .execute('SELECT balance::text AS balance FROM wallets WHERE id = ?', [walletId])) as Array<{
      balance: string;
    }>;
    expect(rows[0]?.balance).toBe('100.00');
  });

  test('after the lock is released the same wallet accepts a bet', async () => {
    const processing = new ProcessWagerTransaction({
      unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm, { lockTimeoutMs: LOCK_TIMEOUT_MS }),
      clock: () => NOW,
      newId: randomUUID,
    });

    const outcome = await processing.execute(betCommand());

    expect(outcome.transaction.status).toBe('PROCESSED');
  });
});
