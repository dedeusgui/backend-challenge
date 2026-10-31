import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { FinancialUnitOfWork } from '../../../src/shared/application/ports/financial-unit-of-work.port';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { WalletQueries } from '../../../src/modules/wallet/application/wallet-queries';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

const NOW = new Date('2026-07-29T15:00:00.000Z');
/** Long enough for an uncontended debit to commit, so that a commit inside the window is not a timing accident. */
const WINDOW_MS = 2_000;

let database: TestDatabase;
let unitOfWork: MikroOrmFinancialUnitOfWork;
let openWallet: OpenWallet;
let processWager: ProcessWagerTransaction;

beforeAll(async () => {
  database = await createTestDatabase();
  unitOfWork = new MikroOrmFinancialUnitOfWork(database.orm);
  const dependencies = { unitOfWork, clock: () => NOW, newId: randomUUID };
  openWallet = new OpenWallet(dependencies);
  processWager = new ProcessWagerTransaction(dependencies);
});

afterAll(async () => {
  await database.drop();
});

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function bet(walletId: string, playerId: string, amount: string): ProcessWagerCommand {
  const externalTransactionId = `transaction-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl(amount),
    referenceExternalTransactionId: undefined,
    correlationId: `corr-${randomUUID()}`,
  };
}

async function balanceOf(walletId: string): Promise<string | undefined> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [walletId])) as Array<{
    balance: string;
  }>;
  return rows[0]?.balance;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * A unit of work whose ledger summary first runs `beforeSummary`. The summary is the step that
 * follows the wallet read, so the hook sits exactly in the window a concurrent writer can use.
 */
function unitOfWorkPausingBeforeSummary(beforeSummary: () => Promise<void>): FinancialUnitOfWork {
  return {
    run: (work) =>
      unitOfWork.run((repositories) =>
        work({
          ...repositories,
          ledger: {
            append: (entry) => repositories.ledger.append(entry),
            listByWallet: (walletId) => repositories.ledger.listByWallet(walletId),
            listPageAfter: (walletId, afterSeq, limit) =>
              repositories.ledger.listPageAfter(walletId, afterSeq, limit),
            summarize: async (walletId, currency) => {
              await beforeSummary();
              return repositories.ledger.summarize(walletId, currency);
            },
          },
        }),
      ),
  };
}

describe('reconciliation while a debit is in progress', () => {
  test('a debit cannot commit between the wallet read and the ledger read, so the wallet is not reported divergent', async () => {
    const playerId = `player-${randomUUID()}`;
    const { walletId } = await openWallet.execute({ playerId, initialBalance: brl('100.00') });
    const debits: Array<Promise<unknown>> = [];
    let debitCommittedInWindow = false;
    const queries = new WalletQueries({
      unitOfWork: unitOfWorkPausingBeforeSummary(async () => {
        const debit = processWager.execute(bet(walletId, playerId, '25.00'));
        debits.push(debit);
        const outcome = await Promise.race([
          debit.then(() => 'committed'),
          sleep(WINDOW_MS).then(() => 'still waiting'),
        ]);
        debitCommittedInWindow = outcome === 'committed';
      }),
      clock: () => NOW,
      newId: randomUUID,
    });

    const report = await queries.reconcile(walletId);

    expect(report.consistent).toBe(true);
    expect(report.difference.isZero()).toBe(true);
    expect(debitCommittedInWindow).toBe(false);

    await Promise.all(debits);
    expect(await balanceOf(walletId)).toBe('75.00');
  }, 30_000);
});
