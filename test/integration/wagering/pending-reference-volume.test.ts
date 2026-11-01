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
 * A backlog of held references must drain. The attempt limit bounds how long each one stays in the queue, and a
 * pass examines at most one batch, so a large backlog costs bounded work per pass and no transaction waits forever.
 * The batch size is the one the worker uses: twenty.
 */

const HOUR_MS = 3_600_000;
const BACKLOG = 45;
const BATCH = 20;

let database: TestDatabase;
let processWager: ProcessWagerTransaction;
let openWallet: OpenWallet;
let unitOfWork: MikroOrmFinancialUnitOfWork;

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

function refund(
  walletId: string,
  playerId: string,
  externalTransactionId: string,
): ProcessWagerCommand {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'REFUND',
    money: Money.from({ amount: '1.00', currency: 'BRL' }),
    referenceExternalTransactionId: `bet-missing-${externalTransactionId}`,
    correlationId: 'corr',
  };
}

async function countWhere(prefix: string, condition: string): Promise<number> {
  const rows = (await database.orm.em.getConnection().execute(
    `SELECT count(*)::text AS n FROM wager_transactions
      WHERE provider_id = 'provider-a' AND external_transaction_id LIKE ? AND ${condition}`,
    [`${prefix}%`],
  )) as Array<{ n: string }>;
  return Number(required(rows[0], 'a count').n);
}

describe('a backlog of held references', () => {
  test('drains within the attempt limit, one bounded batch per pass, and leaves no transaction waiting', async () => {
    const playerId = `player-${randomUUID()}`;
    const { walletId } = await openWallet.execute({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const prefix = `backlog-${randomUUID()}-`;
    for (let index = 0; index < BACKLOG; index += 1) {
      await processWager.execute(refund(walletId, playerId, `${prefix}${index}`));
    }
    expect(await countWhere(prefix, `status = 'PENDING_REFERENCE'`)).toBe(BACKLOG);

    const worker = new ProcessPendingReferences({
      unitOfWork,
      clock: () => new Date(),
      newId: randomUUID,
    });
    let largestPass = 0;
    let examined = 0;
    for (let round = 0; round < MAX_REFERENCE_ATTEMPTS; round += 1) {
      await advanceReferenceClock(database, HOUR_MS);
      let pass: number;
      do {
        pass = await worker.runOnce();
        largestPass = Math.max(largestPass, pass);
        examined += pass;
      } while (pass > 0);
    }

    expect(largestPass).toBeLessThanOrEqual(BATCH);
    expect(examined).toBe(BACKLOG * MAX_REFERENCE_ATTEMPTS);
    expect(await countWhere(prefix, `status = 'PENDING_REFERENCE'`)).toBe(0);
    expect(
      await countWhere(prefix, `status = 'REJECTED' AND failure_code = 'REFERENCE_NOT_FOUND'`),
    ).toBe(BACKLOG);
    expect(await balanceOf(walletId)).toBe('100.00');
  }, 120_000);
});

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT balance::text AS b FROM wallets WHERE id = ?`, [walletId])) as Array<{
    b: string;
  }>;
  return required(rows[0]?.b, 'a balance row');
}
