import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import type {
  FinancialRepositories,
  FinancialUnitOfWork,
} from '../../../src/shared/application/ports/financial-unit-of-work';
import type { WalletRepository } from '../../../src/modules/wallet/application/ports/wallet-repository';
import { WalletNotFoundError } from '../../../src/shared/application/application-errors';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { ProcessPendingReferences } from '../../../src/modules/wagering/application/process-pending-references.use-case';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { advanceReferenceClock } from '../support/reference-clock';
import { required } from '../../support/required';

/**
 * A held transaction that can no longer be resolved for a permanent reason is recorded FAILED: terminal, with a
 * failure code and the balance it was held with, and announced. It must not hold up the held transactions behind
 * it. A transient failure is not a verdict: it ends the pass with its error, and the transaction stays held.
 */

const HOUR_MS = 3_600_000;

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

function worker(port: FinancialUnitOfWork): ProcessPendingReferences {
  return new ProcessPendingReferences({
    unitOfWork: port,
    clock: () => new Date(),
    newId: randomUUID,
  });
}

/** The wallet repository with one wallet's lock refused: the reference worker reads the wallet through it. */
function walletRefusedFor(
  wallets: WalletRepository,
  walletId: string,
  refusal: () => Error,
): WalletRepository {
  return new Proxy(wallets, {
    get(target, property) {
      if (property === 'findForUpdate') {
        return async (id: string) => {
          if (id === walletId) {
            throw refusal();
          }
          return target.findForUpdate(id);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The real unit of work, with one wallet's lock refused. Everything else is passed through unchanged. */
function portWithWalletRefused(walletId: string, refusal: () => Error): FinancialUnitOfWork {
  return {
    run: <T>(work: (repositories: FinancialRepositories) => Promise<T>) =>
      unitOfWork.run((repositories) =>
        work({
          ...repositories,
          wallets: walletRefusedFor(repositories.wallets, walletId, refusal),
        }),
      ),
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

function refund(
  wallet: { walletId: string; playerId: string },
  externalTransactionId: string,
  referenceExternalTransactionId: string,
): ProcessWagerCommand {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'REFUND',
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId,
    correlationId: 'corr',
  };
}

async function bet(
  wallet: { walletId: string; playerId: string },
  externalTransactionId: string,
): Promise<void> {
  await processWager.execute({
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    correlationId: 'corr',
  });
}

async function rowOf(externalTransactionId: string): Promise<Record<string, string | null>> {
  const rows = (await database.orm.em.getConnection().execute(
    `SELECT status, failure_code, reference_attempts::text AS attempts, id::text AS id
       FROM wager_transactions WHERE provider_id = 'provider-a' AND external_transaction_id = ?`,
    [externalTransactionId],
  )) as Array<Record<string, string | null>>;
  return required(rows[0], `the transaction ${externalTransactionId}`);
}

async function eventsOf(transactionId: string): Promise<string[]> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY event_type`, [
      transactionId,
    ])) as Array<{ event_type: string }>;
  return rows.map((event) => event.event_type);
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT balance::text AS b FROM wallets WHERE id = ?`, [walletId])) as Array<{
    b: string;
  }>;
  return required(rows[0]?.b, 'a balance row');
}

describe('a held transaction that fails permanently', () => {
  test('is FAILED, announced, and kept terminal, and does not hold up the held transactions behind it', async () => {
    // The poisoned refund is created first, so it is due first and would stop the pass if its failure were not held.
    const poisoned = await fundedWallet('100.00');
    const poisonedRefund = refund(poisoned, `poisoned-${randomUUID()}`, `bet-p-${randomUUID()}`);
    await processWager.execute(poisonedRefund);

    const healthy = await fundedWallet('100.00');
    const healthyId = `healthy-${randomUUID()}`;
    const healthyBetId = `bet-h-${randomUUID()}`;
    await processWager.execute(refund(healthy, healthyId, healthyBetId));
    await bet(healthy, healthyBetId);
    await advanceReferenceClock(database, HOUR_MS);

    const refused = () => new WalletNotFoundError(poisoned.walletId);
    const pass = worker(portWithWalletRefused(poisoned.walletId, refused));
    await expect(pass.runOnce()).resolves.toBeGreaterThanOrEqual(2);

    const failed = await rowOf(poisonedRefund.externalTransactionId);
    expect({ status: failed.status, code: failed.failure_code }).toEqual({
      status: 'FAILED',
      code: 'PROCESSING_FAILED',
    });
    expect(await eventsOf(required(failed.id ?? undefined, 'the id'))).toContain(
      'WagerTransactionFailed',
    );
    expect(await balanceOf(poisoned.walletId)).toBe('100.00');
    expect((await rowOf(healthyId)).status).toBe('PROCESSED');
    expect(await balanceOf(healthy.walletId)).toBe('100.00');

    // A FAILED transaction is never looked up again, even while the wallet stays refused.
    await advanceReferenceClock(database, HOUR_MS);
    await pass.runOnce();
    expect((await rowOf(poisonedRefund.externalTransactionId)).status).toBe('FAILED');

    // Sent again, it is answered with its failure, and with the balance it was held with.
    const replay = await processWager.execute(poisonedRefund);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.status).toBe('FAILED');
    expect(replay.balance.toString()).toBe('100.00');
  });

  test('a transient failure ends the pass with its error, and the transaction stays held for the next pass', async () => {
    const wallet = await fundedWallet('100.00');
    const transientId = `transient-${randomUUID()}`;
    await processWager.execute(refund(wallet, transientId, `bet-t-${randomUUID()}`));
    await advanceReferenceClock(database, HOUR_MS);

    const outage = portWithWalletRefused(
      wallet.walletId,
      () => new Error('the database is unavailable'),
    );
    await expect(worker(outage).runOnce()).rejects.toThrow('the database is unavailable');

    const held = await rowOf(transientId);
    expect({ status: held.status, attempts: held.attempts }).toEqual({
      status: 'PENDING_REFERENCE',
      attempts: '0',
    });
  });
});
