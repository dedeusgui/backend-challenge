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

const T0 = new Date('2026-07-29T15:00:00.000Z');
const HOUR_MS = 3_600_000;

let database: TestDatabase;
let now: Date;
let processWager: ProcessWagerTransaction;
let openWallet: OpenWallet;
let unitOfWork: MikroOrmFinancialUnitOfWork;

beforeAll(async () => {
  database = await createTestDatabase();
  unitOfWork = new MikroOrmFinancialUnitOfWork(database.orm);
  now = T0;
  const dependencies = { unitOfWork, clock: () => now, newId: randomUUID };
  processWager = new ProcessWagerTransaction(dependencies);
  openWallet = new OpenWallet(dependencies);
});

afterAll(async () => {
  await database.drop();
});

/** A new worker instance: nothing is kept in memory, so restarts are simulated by creating one. */
function worker(): ProcessPendingReferences {
  return new ProcessPendingReferences({ unitOfWork, clock: () => now, newId: randomUUID });
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

async function row(externalTransactionId: string): Promise<Record<string, string | null>> {
  const rows = (await database.orm.em.getConnection().execute(
    `SELECT status, failure_code, reference_attempts::text AS attempts, reference_next_attempt_at::text AS next_at, id::text AS id
       FROM wager_transactions WHERE provider_id = 'provider-a' AND external_transaction_id = ?`,
    [externalTransactionId],
  )) as Array<Record<string, string | null>>;
  const found = rows[0];
  if (!found) throw new Error(`no transaction ${externalTransactionId}`);
  return found;
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT balance::text AS b FROM wallets WHERE id = ?`, [walletId])) as Array<{
    b: string;
  }>;
  return rows[0]?.b ?? '';
}

async function countCredits(walletId: string): Promise<number> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(
      `SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'`,
      [walletId],
    )) as Array<{ n: string }>;
  return Number(rows[0]?.n ?? 0);
}

async function eventsOf(transactionId: string): Promise<string[]> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY event_type`, [
      transactionId,
    ])) as Array<{ event_type: string }>;
  return rows.map((event) => event.event_type);
}

describe('pending references', () => {
  test('a held REFUND is applied once its BET has been processed, and announces the result', async () => {
    const wallet = await fundedWallet('100.00');
    const refundId = `refund-${randomUUID()}`;
    const held = await processWager.execute(
      command(wallet.playerId, wallet.walletId, {
        kind: 'REFUND',
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        externalTransactionId: refundId,
        referenceExternalTransactionId: 'bet-late',
      }),
    );
    expect(held.transaction.status).toBe('PENDING_REFERENCE');
    await processWager.execute(
      command(wallet.playerId, wallet.walletId, {
        kind: 'BET',
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        externalTransactionId: 'bet-late',
      }),
    );

    now = new Date(T0.getTime() + HOUR_MS);
    const resolved = await worker().runOnce();

    expect(resolved).toBe(1);
    expect((await row(refundId)).status).toBe('PROCESSED');
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    expect(await eventsOf(held.transaction.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
  });

  test('a replay of a held REFUND returns the balance it was held with, not the balance after a later change', async () => {
    const wallet = await fundedWallet('100.00');
    const refund = command(wallet.playerId, wallet.walletId, {
      kind: 'REFUND',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      externalTransactionId: `refund-${randomUUID()}`,
      referenceExternalTransactionId: 'bet-not-yet',
    });
    const held = await processWager.execute(refund);
    expect(held.transaction.status).toBe('PENDING_REFERENCE');
    expect(held.balance.toString()).toBe('100.00');
    await processWager.execute(
      command(wallet.playerId, wallet.walletId, {
        kind: 'BET',
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        externalTransactionId: `bet-other-${randomUUID()}`,
      }),
    );
    expect(await balanceOf(wallet.walletId)).toBe('70.00');

    const replay = await processWager.execute(refund);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.status).toBe('PENDING_REFERENCE');
    expect(replay.balance.toString()).toBe('100.00');
  });

  test('retries are scheduled with backoff and are not attempted before they are due', async () => {
    const wallet = await fundedWallet('100.00');
    const refundId = `refund-${randomUUID()}`;
    now = T0;
    await processWager.execute(
      command(wallet.playerId, wallet.walletId, {
        kind: 'REFUND',
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        externalTransactionId: refundId,
        referenceExternalTransactionId: 'bet-slow',
      }),
    );

    now = new Date(T0.getTime() + 1);
    expect(await worker().runOnce()).toBe(0);
    expect((await row(refundId)).attempts).toBe('0');

    now = new Date(T0.getTime() + 60_000);
    expect(await worker().runOnce()).toBe(1);
    expect((await row(refundId)).attempts).toBe('1');
    expect(new Date((await row(refundId)).next_at ?? '').getTime()).toBeGreaterThan(now.getTime());
  });

  test('after the attempt limit the transaction is REJECTED with REFERENCE_NOT_FOUND and announced, with no balance effect', async () => {
    const wallet = await fundedWallet('100.00');
    const refundId = `refund-${randomUUID()}`;
    now = T0;
    const held = await processWager.execute(
      command(wallet.playerId, wallet.walletId, {
        kind: 'REFUND',
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        externalTransactionId: refundId,
        referenceExternalTransactionId: 'bet-never',
      }),
    );

    for (let step = 0; step < MAX_REFERENCE_ATTEMPTS + 2; step += 1) {
      now = new Date(now.getTime() + HOUR_MS);
      await worker().runOnce();
    }

    const finalRow = await row(refundId);
    expect(finalRow.status).toBe('REJECTED');
    expect(finalRow.failure_code).toBe('REFERENCE_NOT_FOUND');
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    expect(await eventsOf(held.transaction.id)).toContain('WagerTransactionRejected');
  });

  test('a restarted worker continues the persisted schedule instead of starting over', async () => {
    const wallet = await fundedWallet('100.00');
    const refundId = `refund-${randomUUID()}`;
    now = T0;
    await processWager.execute(
      command(wallet.playerId, wallet.walletId, {
        kind: 'REFUND',
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        externalTransactionId: refundId,
        referenceExternalTransactionId: 'bet-restart',
      }),
    );
    now = new Date(T0.getTime() + HOUR_MS);
    await worker().runOnce();
    expect((await row(refundId)).attempts).toBe('1');

    now = new Date(T0.getTime() + 2 * HOUR_MS);
    await worker().runOnce();

    expect((await row(refundId)).attempts).toBe('2');
  });

  test('two workers resolving the same held transaction apply its effect once', async () => {
    const wallet = await fundedWallet('100.00');
    const refundId = `refund-${randomUUID()}`;
    now = T0;
    await processWager.execute(
      command(wallet.playerId, wallet.walletId, {
        kind: 'REFUND',
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        externalTransactionId: refundId,
        referenceExternalTransactionId: 'bet-race',
      }),
    );
    await processWager.execute(
      command(wallet.playerId, wallet.walletId, {
        kind: 'BET',
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        externalTransactionId: 'bet-race',
      }),
    );

    now = new Date(T0.getTime() + HOUR_MS);
    await Promise.all([worker().runOnce(), worker().runOnce()]);

    expect((await row(refundId)).status).toBe('PROCESSED');
    expect(await countCredits(wallet.walletId)).toBe(2);
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
  });

  test('six workers racing over six held refunds of one wallet apply each refund exactly once', async () => {
    const wallet = await fundedWallet('100.00');
    const refunds = Array.from({ length: 6 }, (_, index) => `refund-load-${index}-${randomUUID()}`);
    now = T0;
    for (const [index, refundId] of refunds.entries()) {
      await processWager.execute(
        command(wallet.playerId, wallet.walletId, {
          kind: 'REFUND',
          money: Money.from({ amount: '10.00', currency: 'BRL' }),
          externalTransactionId: refundId,
          referenceExternalTransactionId: `bet-load-${index}`,
        }),
      );
    }
    for (const index of refunds.keys()) {
      await processWager.execute(
        command(wallet.playerId, wallet.walletId, {
          kind: 'BET',
          money: Money.from({ amount: '10.00', currency: 'BRL' }),
          externalTransactionId: `bet-load-${index}`,
        }),
      );
    }

    now = new Date(T0.getTime() + HOUR_MS);
    await Promise.all(Array.from({ length: 6 }, () => worker().runOnce()));

    for (const refundId of refunds) {
      expect((await row(refundId)).status).toBe('PROCESSED');
    }
    expect(await countCredits(wallet.walletId)).toBe(1 + refunds.length);
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
  }, 60_000);
});
