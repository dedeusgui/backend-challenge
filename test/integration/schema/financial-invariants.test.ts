import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransaction } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { assertFinancialInvariants } from '../../../scripts/check-financial-invariants';
import { type TestDatabase, createTestDatabase } from '../support/test-database';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ verifyLedgerInvariant: false });
});

afterAll(async () => {
  await database.drop();
});

describe('financial invariant verifier', () => {
  test('accepts a migrated database with consistent financial state', async () => {
    await assertFinancialInvariants(database.orm);
  });

  test('accepts a WIN and ROLLBACK that both reference the same BET', async () => {
    const unitOfWork = new MikroOrmFinancialUnitOfWork(database.orm);
    const dependencies = {
      unitOfWork,
      clock: () => new Date('2026-11-01T12:00:00.000Z'),
      newId: randomUUID,
    };
    const openWallet = new OpenWallet(dependencies);
    const processWager = new ProcessWagerTransaction(dependencies);
    const playerId = `player-${randomUUID()}`;
    const { walletId } = await openWallet.execute({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const betId = `bet-${randomUUID()}`;
    const submit = (kind: 'BET' | 'WIN' | 'ROLLBACK', amount: string, reference?: string) => {
      const externalTransactionId = `${kind.toLowerCase()}-${randomUUID()}`;
      return processWager.execute({
        idempotencyKey: `provider-a:${externalTransactionId}`,
        providerId: 'provider-a',
        externalTransactionId: kind === 'BET' ? betId : externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind,
        money: Money.from({ amount, currency: 'BRL' }),
        referenceExternalTransactionId: reference,
        correlationId: `corr-${randomUUID()}`,
      });
    };

    await submit('BET', '25.00');
    await submit('WIN', '50.00', betId);
    await submit('ROLLBACK', '25.00', betId);

    await assertFinancialInvariants(database.orm);
  });

  test('fails when the materialized wallet balance has no ledger entry', async () => {
    const id = randomUUID();

    await database.orm.em.fork().transactional(async (em) => {
      await em.execute('ALTER TABLE wallets DISABLE TRIGGER ALL');
      await em.execute('ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ALL');
      await em.execute(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', 1.00, 1, now(), now())`,
        [id, `invalid-ledger-${id}`],
      );
      await em.execute('ALTER TABLE wallet_ledger_entries ENABLE TRIGGER ALL');
      await em.execute('ALTER TABLE wallets ENABLE TRIGGER ALL');
    });

    await expect(assertFinancialInvariants(database.orm)).rejects.toThrow('INV-02');

    const child = Bun.spawn([process.execPath, 'run', 'scripts/check-financial-invariants.ts'], {
      env: { ...process.env, DATABASE_URL: database.url },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain('INV-02');
  });
});
