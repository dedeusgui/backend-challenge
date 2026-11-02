import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fc from 'fast-check';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { WalletQueries } from '../../../src/modules/wallet/application/wallet-queries';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
  type ProcessWagerOutcome,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

const NOW = new Date('2026-07-29T15:00:00.000Z');
const INITIAL_BALANCE_CENTS = 10_000n;
const STAKE_CENTS = 100n;
const ACTION_KINDS = ['WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

type ActionKind = (typeof ACTION_KINDS)[number];
interface Action {
  readonly kind: ActionKind;
  readonly payoutCents: number;
}

interface ReferenceModel {
  balanceCents: bigint;
  settled: boolean;
  reversed: boolean;
  ledgerEntries: number;
}

interface ExpectedOutcome {
  readonly status: 'PROCESSED' | 'REJECTED';
  readonly failureCode: 'REFERENCE_ALREADY_REVERSED' | 'REFERENCE_ALREADY_SETTLED' | undefined;
}

let database: TestDatabase;
let openWallet: OpenWallet;
let processWager: ProcessWagerTransaction;
let queries: WalletQueries;

function cents(amount: bigint | number): string {
  const value = BigInt(amount);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

function money(amountCents: bigint | number): Money {
  return Money.from({ amount: cents(amountCents), currency: 'BRL' });
}

function command(
  playerId: string,
  walletId: string,
  externalTransactionId: string,
  kind: ProcessWagerCommand['kind'],
  amountCents: bigint | number,
  referenceExternalTransactionId?: string,
): ProcessWagerCommand {
  return {
    idempotencyKey: `property-model:${externalTransactionId}`,
    providerId: 'property-model',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'property-round',
    gameId: 'property-game',
    kind,
    money: money(amountCents),
    referenceExternalTransactionId,
    correlationId: externalTransactionId,
  };
}

/**
 * Independent reference rules for one BET and operations naming it. D1-D4 are kept explicit here:
 * one linked result, at most one reversal, REFUND only before a result, and ROLLBACK of the BET
 * remains valid after a result. The reducer intentionally does not call production domain helpers.
 */
function applyToModel(model: ReferenceModel, action: Action): ExpectedOutcome {
  if (model.reversed) {
    return { status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' };
  }
  if (action.kind !== 'ROLLBACK' && model.settled) {
    return { status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_SETTLED' };
  }

  switch (action.kind) {
    case 'WIN':
      model.balanceCents += BigInt(action.payoutCents);
      model.settled = true;
      model.ledgerEntries += 1;
      break;
    case 'LOSS':
      model.settled = true;
      break;
    case 'REFUND':
    case 'ROLLBACK':
      // Both credit the stake when they reverse this original BET.
      model.balanceCents += STAKE_CENTS;
      model.reversed = true;
      model.ledgerEntries += 1;
      break;
  }

  return { status: 'PROCESSED', failureCode: undefined };
}

function expectOutcome(
  actual: ProcessWagerOutcome,
  expected: ExpectedOutcome,
  expectedBalanceCents: bigint,
  isReplay: boolean,
): void {
  expect({
    status: actual.transaction.status,
    failureCode: actual.transaction.failureCode,
    balance: actual.balance.toString(),
    replay: actual.idempotentReplay,
  }).toEqual({
    status: expected.status,
    failureCode: expected.failureCode,
    balance: cents(expectedBalanceCents),
    replay: isReplay,
  });
}

async function expectPersistedState(
  walletId: string,
  model: ReferenceModel,
  operationCount: number,
): Promise<void> {
  const rows = (await database.orm.em.getConnection().execute(
    `SELECT w.balance::text AS balance,
            count(l.id)::int AS ledger_entries,
            COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
              ::numeric(20,2)::text AS ledger_balance
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ?
      GROUP BY w.id`,
    [walletId],
  )) as Array<{ balance: string; ledger_entries: number; ledger_balance: string }>;
  const row = rows[0];
  expect(row).toBeDefined();
  expect(row).toMatchObject({
    balance: cents(model.balanceCents),
    ledger_entries: model.ledgerEntries,
    ledger_balance: cents(model.balanceCents),
  });

  const transactions = (await database.orm.em
    .getConnection()
    .execute(`SELECT count(*)::int AS count FROM wager_transactions WHERE wallet_id = ?`, [
      walletId,
    ])) as Array<{ count: number }>;
  expect(transactions[0]?.count).toBe(operationCount + 1); // The opening transaction is internal.

  const reconciliation = await queries.reconcile(walletId);
  expect(reconciliation.consistent).toBe(true);
  expect(reconciliation.checkedEntries).toBe(model.ledgerEntries);
}

beforeAll(async () => {
  database = await createTestDatabase();
  const context = {
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => NOW,
    newId: randomUUID,
  };
  openWallet = new OpenWallet(context);
  processWager = new ProcessWagerTransaction(context);
  queries = new WalletQueries(context);
});

afterAll(async () => {
  await database.drop();
});

describe('generated financial sequences against an independent reference model', () => {
  test('bounded settlements, reversals, conflicts and replays match the model at every step', async () => {
    const observedKinds = new Set<ActionKind>();
    const actions = fc.array(
      fc.record({
        kind: fc.constantFrom(...ACTION_KINDS),
        payoutCents: fc.integer({ min: 1, max: 500 }),
      }),
      { minLength: 1, maxLength: 12 },
    );

    await fc.assert(
      fc.asyncProperty(actions, async (sequence) => {
        const playerId = `property-player-${randomUUID()}`;
        const { walletId } = await openWallet.execute({
          playerId,
          initialBalance: money(INITIAL_BALANCE_CENTS),
        });
        const betId = `property-bet-${randomUUID()}`;
        const bet = command(playerId, walletId, betId, 'BET', STAKE_CENTS);
        const model: ReferenceModel = {
          balanceCents: INITIAL_BALANCE_CENTS - STAKE_CENTS,
          settled: false,
          reversed: false,
          ledgerEntries: 2, // Opening credit and the BET debit.
        };
        const betOutcome = await processWager.execute(bet);
        const expectedBet: ExpectedOutcome = { status: 'PROCESSED', failureCode: undefined };
        expectOutcome(betOutcome, expectedBet, model.balanceCents, false);
        const betReplay = await processWager.execute(bet);
        expectOutcome(betReplay, expectedBet, model.balanceCents, true);
        expect(betReplay.transaction.id).toBe(betOutcome.transaction.id);

        for (const [index, action] of sequence.entries()) {
          observedKinds.add(action.kind);
          const amountCents = action.kind === 'WIN' ? action.payoutCents : STAKE_CENTS;
          const wager = command(
            playerId,
            walletId,
            `property-action-${index}-${randomUUID()}`,
            action.kind,
            amountCents,
            betId,
          );
          const expected = applyToModel(model, action);
          const outcome = await processWager.execute(wager);
          expectOutcome(outcome, expected, model.balanceCents, false);
          expect(model.balanceCents >= 0n).toBe(true);
          expect(outcome.balance.isNegative()).toBe(false);

          const replay = await processWager.execute(wager);
          expect({
            status: replay.transaction.status,
            failureCode: replay.transaction.failureCode,
            balance: replay.balance.toString(),
            replay: replay.idempotentReplay,
            transactionId: replay.transaction.id,
          }).toEqual({
            status: expected.status,
            failureCode: expected.failureCode,
            balance: outcome.balance.toString(),
            replay: true,
            transactionId: outcome.transaction.id,
          });
        }

        await expectPersistedState(walletId, model, sequence.length + 1);
      }),
      { seed: 20261102, numRuns: 12 },
    );

    expect([...observedKinds].sort()).toEqual([...ACTION_KINDS].sort());
  }, 60_000);
});
