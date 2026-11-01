import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { ProcessPendingReferences } from '../../../src/modules/wagering/application/process-pending-references.use-case';
import { MAX_REFERENCE_ATTEMPTS } from '../../../src/modules/wagering/domain/reference-retry-policy';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { advanceReferenceClock } from '../support/reference-clock';
import { required } from '../../support/required';

/**
 * Held references are looked up and rescheduled on the database clock, so the workers' own clocks do not decide
 * when a reference is due or when the next lookup is. A worker an hour ahead must not look up a reference early,
 * and a worker an hour behind must not starve it. A reference that arrives after its transaction was rejected for
 * the attempt limit leaves the rejection standing.
 */

const SKEW_MS = 60 * 60 * 1000;

let database: TestDatabase;
let unitOfWork: MikroOrmFinancialUnitOfWork;
let processWager: ProcessWagerTransaction;
let openWallet: OpenWallet;

beforeAll(async () => {
  database = await createTestDatabase();
  unitOfWork = new MikroOrmFinancialUnitOfWork(database.orm);
  const dependencies = { unitOfWork, clock: () => new Date(), newId: randomUUID };
  processWager = new ProcessWagerTransaction(dependencies);
  openWallet = new OpenWallet(dependencies);
}, 60_000);

afterAll(async () => {
  await database.drop();
});

/** A worker whose own clock runs `offsetMs` from the real time. The database clock is the same for all of them. */
function worker(offsetMs: number): ProcessPendingReferences {
  return new ProcessPendingReferences({
    unitOfWork,
    clock: () => new Date(Date.now() + offsetMs),
    newId: randomUUID,
  });
}

function command(
  playerId: string,
  walletId: string,
  overrides: Partial<ProcessWagerCommand> & Pick<ProcessWagerCommand, 'kind' | 'money'>,
): ProcessWagerCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    referenceExternalTransactionId: undefined,
    correlationId: 'corr',
    ...overrides,
  };
}

async function fundedWallet(amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount, currency: 'BRL' }),
  });
  return { walletId, playerId };
}

/** A REFUND whose BET has not arrived: it is held, with its first lookup due in one second on the database clock. */
async function heldRefund(walletId: string, playerId: string): Promise<string> {
  const refundId = `refund-${randomUUID()}`;
  await processWager.execute(
    command(playerId, walletId, {
      kind: 'REFUND',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      externalTransactionId: refundId,
      referenceExternalTransactionId: `bet-${randomUUID()}`,
    }),
  );
  return refundId;
}

async function rowOf(externalTransactionId: string): Promise<Record<string, string | null>> {
  const rows = (await database.orm.em.getConnection().execute(
    `SELECT status, failure_code, reference_attempts::text AS attempts,
            EXTRACT(EPOCH FROM (reference_next_attempt_at - now()))::text AS seconds_until_next
       FROM wager_transactions WHERE provider_id = 'provider-a' AND external_transaction_id = ?`,
    [externalTransactionId],
  )) as Array<Record<string, string | null>>;
  return required(rows[0], `the transaction ${externalTransactionId}`);
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT balance::text AS b FROM wallets WHERE id = ?`, [walletId])) as Array<{
    b: string;
  }>;
  return required(rows[0]?.b, 'a balance row');
}

/** Ledger entries of a wallet: the opening balance and one entry per applied movement. */
async function ledgerEntryCount(walletId: string): Promise<number> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ?`, [
      walletId,
    ])) as Array<{ n: string }>;
  return Number(required(rows[0], 'a count').n);
}

describe('held references are looked up on the database clock', () => {
  test('a worker whose clock runs an hour ahead does not look up a reference that is not yet due', async () => {
    const wallet = await fundedWallet('100.00');
    const refundId = await heldRefund(wallet.walletId, wallet.playerId);

    // Other tests leave held references in this database too, so the claim is read from this one transaction.
    await worker(SKEW_MS).runOnce();
    expect((await rowOf(refundId)).attempts).toBe('0');
  });

  test('a worker whose clock runs an hour behind looks up a reference that the database says is due', async () => {
    const wallet = await fundedWallet('100.00');
    const refundId = await heldRefund(wallet.walletId, wallet.playerId);
    await advanceReferenceClock(database, 2_000);

    await worker(-SKEW_MS).runOnce();
    expect((await rowOf(refundId)).attempts).toBe('1');
  });

  test('a miss schedules the next lookup from the database clock, whichever worker records it', async () => {
    const wallet = await fundedWallet('100.00');
    const refundId = await heldRefund(wallet.walletId, wallet.playerId);
    await advanceReferenceClock(database, 2_000);

    await worker(SKEW_MS).runOnce();
    const seconds = Number(required((await rowOf(refundId)).seconds_until_next, 'the schedule'));
    // The second attempt waits two seconds after the first miss, measured on the database clock.
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(3);
  });
});

describe('a reference that arrives after the attempt limit', () => {
  test('leaves the REJECTED transaction standing, with no balance effect, and is not looked up again', async () => {
    const wallet = await fundedWallet('100.00');
    const rollbackId = `rollback-${randomUUID()}`;
    const betId = `bet-${randomUUID()}`;
    const rollback = command(wallet.playerId, wallet.walletId, {
      kind: 'ROLLBACK',
      money: Money.from({ amount: '1.00', currency: 'BRL' }),
      externalTransactionId: rollbackId,
      referenceExternalTransactionId: betId,
    });
    await processWager.execute(rollback);

    const pending = worker(0);
    for (let step = 0; step < MAX_REFERENCE_ATTEMPTS; step += 1) {
      await advanceReferenceClock(database, 60_000);
      await pending.runOnce();
    }
    const rejected = await rowOf(rollbackId);
    expect({ status: rejected.status, failure: rejected.failure_code }).toEqual({
      status: 'REJECTED',
      failure: 'REFERENCE_NOT_FOUND',
    });

    // The BET arrives after the rejection.
    await processWager.execute(
      command(wallet.playerId, wallet.walletId, {
        kind: 'BET',
        money: Money.from({ amount: '1.00', currency: 'BRL' }),
        externalTransactionId: betId,
      }),
    );
    await advanceReferenceClock(database, 60_000);
    await pending.runOnce();
    expect((await rowOf(rollbackId)).attempts).toBe(String(MAX_REFERENCE_ATTEMPTS));

    // Sent again, the ROLLBACK is answered with its rejection, and the balance is the BET's debit alone.
    const replay = await processWager.execute(rollback);
    expect(replay.idempotentReplay).toBe(true);
    expect((await rowOf(rollbackId)).status).toBe('REJECTED');
    expect(await balanceOf(wallet.walletId)).toBe('99.00');
    // The opening entry and the BET's debit. A rollback applied on top of them would be a third entry.
    expect(await ledgerEntryCount(wallet.walletId)).toBe(2);
  });
});
