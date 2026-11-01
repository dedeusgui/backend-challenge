import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { IdempotencyConflictError } from '../../../src/shared/application/application-errors';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { WalletQueries } from '../../../src/modules/wallet/application/wallet-queries';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
  type ProcessWagerOutcome,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { ProcessPendingReferences } from '../../../src/modules/wagering/application/process-pending-references.use-case';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * Randomized sequences of provider operations, run through the real use cases, with the properties that must hold
 * for every sequence and every interleaving. The sequences are seeded, so a failure names the seed that reproduces it.
 *
 * The properties do not restate the code. They are the consequences of the rules: the stored balance equals the
 * ledger, no balance is negative, the version counts the movements, no BET is settled or reversed twice, every
 * ledger entry belongs to a processed operation of its wallet, and a resend of any command answers the same
 * transaction. Serial runs and concurrent runs (several apps on one database) must both satisfy them.
 */

const START = new Date('2026-07-29T15:00:00.000Z');
const PASS_MS = 120_000;
const WALLETS = 3;

/** A seeded generator (mulberry32). The same seed always yields the same sequence. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Known {
  externalTransactionId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  amount: string;
  walletIndex: number;
}

interface Wallet {
  walletId: string;
  playerId: string;
}

let database: TestDatabase;
let wallets: Wallet[];
let clock: Date;
let processWager: ProcessWagerTransaction;
let pending: ProcessPendingReferences;
let queries: WalletQueries;

function amountOf(random: () => number, max: number): string {
  const cents = 100 + Math.floor(random() * (max * 100 - 100));
  return (cents / 100).toFixed(2);
}

/** A reproducible list of commands. Some reference an earlier operation, some name one that does not exist yet. */
function sequenceFor(
  seed: number,
  length: number,
  walletsOf: readonly Wallet[],
): ProcessWagerCommand[] {
  const random = generator(seed);
  const known: Known[] = [];
  const commands: ProcessWagerCommand[] = [];
  for (let index = 0; index < length; index += 1) {
    const walletIndex = Math.floor(random() * walletsOf.length);
    const wallet = walletsOf[walletIndex];
    if (wallet === undefined) {
      throw new Error('a wallet index outside the wallets');
    }
    const roll = random();
    const externalTransactionId = `t-${seed}-${index}-${randomUUID().slice(0, 8)}`;
    let kind: Known['kind'] = 'BET';
    let reference: string | undefined;
    let amount = amountOf(random, 40);
    if (roll < 0.4 || known.length === 0) {
      kind = 'BET';
    } else {
      const target = known[Math.floor(random() * known.length)];
      if (target === undefined) {
        throw new Error('no reference to choose');
      }
      const pick = random();
      if (pick < 0.15) {
        // A reference that does not exist yet: the operation waits for it, as a late reference would.
        reference = `future-${seed}-${index}`;
        kind = random() < 0.5 ? 'REFUND' : 'ROLLBACK';
        amount = amountOf(random, 40);
      } else if (pick < 0.45) {
        kind = 'WIN';
        reference = target.externalTransactionId;
        amount = amountOf(random, 80);
      } else if (pick < 0.55) {
        kind = 'LOSS';
        reference = target.externalTransactionId;
        amount = '0.00';
      } else {
        kind = pick < 0.8 ? 'REFUND' : 'ROLLBACK';
        reference = target.externalTransactionId;
        amount = target.amount;
      }
    }
    commands.push({
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: `round-${walletIndex}`,
      gameId: 'game-1',
      kind,
      money: Money.from({ amount: kind === 'LOSS' ? '1.00' : amount, currency: 'BRL' }),
      referenceExternalTransactionId: reference,
      correlationId: externalTransactionId,
    });
    if (kind !== 'LOSS' || amount !== '0.00') {
      known.push({
        externalTransactionId,
        kind,
        amount: kind === 'LOSS' ? '1.00' : amount,
        walletIndex,
      });
    }
  }
  return commands;
}

async function openWallets(count: number, initial: string): Promise<Wallet[]> {
  const opener = new OpenWallet({
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => clock,
    newId: randomUUID,
  });
  const opened: Wallet[] = [];
  for (let index = 0; index < count; index += 1) {
    const playerId = `player-${randomUUID()}`;
    const { walletId } = await opener.execute({
      playerId,
      initialBalance: Money.from({ amount: initial, currency: 'BRL' }),
    });
    opened.push({ walletId, playerId });
  }
  return opened;
}

/** Runs one application: a use case instance over the shared database, with its own transactions. */
function application(): { wagers: ProcessWagerTransaction; references: ProcessPendingReferences } {
  const context = {
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => clock,
    newId: randomUUID,
  };
  return {
    wagers: new ProcessWagerTransaction(context),
    references: new ProcessPendingReferences(context),
  };
}

/** Lets every held operation reach its reference, or exhaust its attempts, as time passes. */
async function drainPendingReferences(): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    clock = new Date(clock.getTime() + PASS_MS);
    await pending.runOnce();
    const left = await count(
      `SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
      [],
    );
    if (left === 0) {
      return;
    }
  }
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const rows = (await database.orm.em.getConnection().execute(sql, params)) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** The properties that must hold after any run, serial or concurrent. Each one names the rule it protects. */
async function assertFinancialProperties(
  walletsChecked: readonly Wallet[],
  seed: string,
): Promise<void> {
  const label = `seed ${seed}`;
  for (const wallet of walletsChecked) {
    const report = await queries.reconcile(wallet.walletId);
    expect({ label, wallet: wallet.walletId, consistent: report.consistent }).toEqual({
      label,
      wallet: wallet.walletId,
      consistent: true,
    });
  }

  expect({
    label,
    negative: await count(`SELECT count(*)::int AS n FROM wallets WHERE balance < 0`, []),
  }).toEqual({
    label,
    negative: 0,
  });

  expect({
    label,
    versionMismatches: await count(
      `SELECT count(*)::int AS n FROM wallets w
        WHERE w.version <> (SELECT count(*) FROM wallet_ledger_entries l WHERE l.wallet_id = w.id)`,
      [],
    ),
  }).toEqual({ label, versionMismatches: 0 });

  expect({
    label,
    ledgerWithoutProcessedOperation: await count(
      `SELECT count(*)::int AS n FROM wallet_ledger_entries l
         JOIN wager_transactions t ON t.id = l.transaction_id
        WHERE t.status <> 'PROCESSED' OR t.amount <> l.amount OR t.wallet_id <> l.wallet_id`,
      [],
    ),
  }).toEqual({ label, ledgerWithoutProcessedOperation: 0 });

  expect({
    label,
    settledTwice: await count(
      `SELECT count(*)::int AS n FROM (SELECT reference_transaction_id FROM wager_transactions
         WHERE status = 'PROCESSED' AND kind IN ('WIN','LOSS','REFUND') AND reference_transaction_id IS NOT NULL
         GROUP BY reference_transaction_id HAVING count(*) > 1) d`,
      [],
    ),
  }).toEqual({ label, settledTwice: 0 });

  expect({
    label,
    reversedTwice: await count(
      `SELECT count(*)::int AS n FROM (SELECT reference_transaction_id FROM wager_transactions
         WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK') AND reference_transaction_id IS NOT NULL
         GROUP BY reference_transaction_id HAVING count(*) > 1) d`,
      [],
    ),
  }).toEqual({ label, reversedTwice: 0 });

  expect({
    label,
    stillPending: await count(
      `SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING'`,
      [],
    ),
  }).toEqual({ label, stillPending: 0 });

  expect({
    label,
    terminalWithoutEvent: await count(
      `SELECT count(*)::int AS n FROM wager_transactions t
        WHERE t.status IN ('PROCESSED','REJECTED')
          AND NOT EXISTS (SELECT 1 FROM outbox_messages o WHERE o.aggregate_id = t.id::text)`,
      [],
    ),
  }).toEqual({ label, terminalWithoutEvent: 0 });
}

/**
 * A sequence that never reaches the interesting outcomes would pass for the wrong reason. These pairs of kind and
 * status must all appear in the run: a settlement, a reversal, a refusal and a held operation that was resolved.
 */
async function assertVariety(seed: string): Promise<void> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT DISTINCT kind, status FROM wager_transactions`, [])) as Array<{
    kind: string;
    status: string;
  }>;
  const seen = new Set(rows.map((row) => `${row.kind}/${row.status}`));
  for (const required of [
    'WIN/PROCESSED',
    'REFUND/PROCESSED',
    'ROLLBACK/PROCESSED',
    'BET/PROCESSED',
    'REFUND/REJECTED',
  ]) {
    expect({ seed, required, seen: seen.has(required) }).toEqual({ seed, required, seen: true });
  }
}

/** A resend of a command answers the transaction that the first delivery created, and says it is a replay. */
async function assertResendsReplay(
  commands: readonly ProcessWagerCommand[],
  seed: string,
): Promise<void> {
  const app = application();
  for (const command of commands) {
    const first = await database.orm.em
      .getConnection()
      .execute(
        `SELECT id, status FROM wager_transactions WHERE provider_id = 'provider-a' AND external_transaction_id = ?`,
        [command.externalTransactionId],
      );
    const row = (first as Array<{ id: string; status: string }>)[0];
    if (row === undefined) {
      continue;
    }
    const outcome: ProcessWagerOutcome = await app.wagers.execute(command);
    expect({ seed, id: outcome.transaction.id, replay: outcome.idempotentReplay }).toEqual({
      seed,
      id: row.id,
      replay: true,
    });
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = START;
  const shared = application();
  processWager = shared.wagers;
  pending = shared.references;
  queries = new WalletQueries({
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => clock,
    newId: randomUUID,
  });
});

afterAll(async () => {
  await database.drop();
});

describe('random sequences, run one application at a time', () => {
  for (const seed of [1, 7, 42, 1001, 65535]) {
    test(`seed ${seed}: every financial property holds after the sequence and a drain of the held operations`, async () => {
      clock = START;
      wallets = await openWallets(WALLETS, '60.00');
      const commands = sequenceFor(seed, 60, wallets);

      for (const command of commands) {
        await processWager.execute(command);
      }
      await drainPendingReferences();

      await assertFinancialProperties(wallets, String(seed));
      await assertVariety(String(seed));
      await assertResendsReplay(commands.slice(0, 15), String(seed));
    }, 60_000);
  }
});

describe('random sequences, run by several applications at once on one database', () => {
  for (const seed of [3, 99, 2026]) {
    test(`seed ${seed}: four applications, with resends from one of them, still satisfy every property`, async () => {
      clock = START;
      wallets = await openWallets(WALLETS, '40.00');
      const commands = sequenceFor(seed, 80, wallets);
      const apps = Array.from({ length: 4 }, () => application());
      const random = generator(seed + 1);

      let next = 0;
      const worker = async (index: number) => {
        const app = apps[index];
        if (app === undefined) {
          throw new Error('an application is missing');
        }
        while (next < commands.length) {
          const command = commands[next];
          next += 1;
          if (command === undefined) {
            throw new Error('a command is missing');
          }
          await app.wagers.execute(command).catch((error: unknown) => {
            // Two applications may race on the same identity: the loser's answer is a replay or a conflict, never a second effect.
            if (!(error instanceof IdempotencyConflictError)) {
              throw error;
            }
          });
          if (random() < 0.2) {
            await app.wagers.execute(command).catch(() => undefined);
          }
          await app.references.runOnce();
        }
      };
      await Promise.all(apps.map((_app, index) => worker(index)));
      await drainPendingReferences();

      await assertFinancialProperties(wallets, `concurrent-${seed}`);
    }, 120_000);
  }
});
