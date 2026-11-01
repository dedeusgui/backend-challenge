/**
 * Measures what the ledger agreement triggers (migration 10) cost on the financial path, against the same
 * database without them, and how one trigger lookup scales with the size of a wallet's ledger.
 *
 * The workload runs the production use cases on fresh databases that differ only in the triggers. The
 * scaling check seeds a ledger directly, without triggers, because it measures the query the trigger runs,
 * not the trigger's own writes.
 *
 * Usage: bun run test/perf/ledger-trigger-cost.ts [rounds] [--lookups]
 *   --lookups runs only the lookup scaling check.
 * (needs DATABASE_URL or the local compose database)
 *
 * It prints one JSON document. Numbers are for this machine and this run only. The decision that uses them
 * is recorded in docs/audit/PERFORMANCE_COMPARISON.md.
 */
import { randomUUID } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { Money } from '../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../src/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';

const HOT_OPERATIONS = 600;
const SPREAD_WALLETS = 120;
const SPREAD_OPERATIONS_PER_WALLET = 3;
const CONCURRENT_WORKERS = 8;
const EXPERIMENT_SQL = new URL(
  '../../docs/audit/experiments/ledger-agreement-triggers.sql',
  import.meta.url,
);
const LOOKUP_SIZES = [1_000, 100_000, 1_000_000] as const;
const ENTRIES_PER_LOOKUP_WALLET = 100;
const LOOKUP_REPEATS = 300;

interface Wallet {
  walletId: string;
  playerId: string;
}

function roundTo(value: number): number {
  return Math.round(value * 100) / 100;
}

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? Number.NaN;
  return {
    count: sorted.length,
    p50: roundTo(at(0.5)),
    p95: roundTo(at(0.95)),
    p99: roundTo(at(0.99)),
    max: roundTo(sorted[sorted.length - 1] ?? Number.NaN),
  };
}

async function openWalletWith(
  openWallet: OpenWallet,
  amount: string,
  prefix: string,
): Promise<Wallet> {
  const playerId = `${prefix}-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount, currency: 'BRL' }),
  });
  return { walletId, playerId };
}

async function timedBet(
  processWager: ProcessWagerTransaction,
  wallet: Wallet,
  index: number,
): Promise<number> {
  const externalTransactionId = `bench-${randomUUID()}`;
  const started = performance.now();
  await processWager.execute({
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: `round-${index}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.from({ amount: '1.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    correlationId: externalTransactionId,
  });
  return performance.now() - started;
}

/** One workload: a hot wallet alone, many small wallets, then the hot wallet with concurrent workers. */
async function runWorkload(database: TestDatabase): Promise<Record<string, number[]>> {
  const dependencies = {
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => new Date(),
    newId: randomUUID,
  };
  const processWager = new ProcessWagerTransaction(dependencies);
  const openWallet = new OpenWallet(dependencies);
  const samples: Record<string, number[]> = {
    hotSequential: [],
    spreadSequential: [],
    hotConcurrent: [],
  };

  const hot = await openWalletWith(openWallet, '100000.00', 'hot');
  for (let index = 0; index < HOT_OPERATIONS; index += 1) {
    samples.hotSequential?.push(await timedBet(processWager, hot, index));
  }

  const spread: Wallet[] = [];
  for (let index = 0; index < SPREAD_WALLETS; index += 1) {
    spread.push(await openWalletWith(openWallet, '1000.00', 'spread'));
  }
  for (let round = 0; round < SPREAD_OPERATIONS_PER_WALLET; round += 1) {
    for (const wallet of spread) {
      samples.spreadSequential?.push(await timedBet(processWager, wallet, round));
    }
  }

  const perWorker = Math.floor(HOT_OPERATIONS / CONCURRENT_WORKERS);
  await Promise.all(
    Array.from({ length: CONCURRENT_WORKERS }, async (_, worker) => {
      for (let index = 0; index < perWorker; index += 1) {
        samples.hotConcurrent?.push(await timedBet(processWager, hot, worker * perWorker + index));
      }
    }),
  );
  return samples;
}

/**
 * `--guards`: the variant is the current schema (migration 10, the row guards), and the baseline is the same
 * schema with that migration reverted. Without the flag, the variant is the ledger-agreement triggers of the
 * experiment, applied on top of the migrations.
 */
const GUARDS = process.argv.includes('--guards');

async function measureVariant(withVariant: boolean): Promise<Record<string, number[]>> {
  const database = await createTestDatabase({ verifyLedgerInvariant: false });
  try {
    if (GUARDS && !withVariant) {
      await database.orm.migrator.down();
    }
    if (!GUARDS && withVariant) {
      await database.orm.em.getConnection().execute(await Bun.file(EXPERIMENT_SQL).text());
    }
    return await runWorkload(database);
  } finally {
    await database.drop();
  }
}

/**
 * Seeds a ledger of `total` entries spread over wallets of ENTRIES_PER_LOOKUP_WALLET entries each, without
 * triggers, and times the lookup the trigger runs for one of those wallets: its last entry, through the
 * (wallet_id, seq) index. A ledger that holds one wallet alone would not show the planner's choice that
 * matters, which is between that index and a backward scan of the whole ledger.
 */
async function lookupCost(
  total: number,
): Promise<{ total: number; wallets: number; millisecondsPerLookup: number; plan: string }> {
  const database = await createTestDatabase({ verifyLedgerInvariant: false });
  try {
    const connection = database.orm.em.getConnection();
    const wallets = Math.max(1, Math.floor(total / ENTRIES_PER_LOOKUP_WALLET));
    await connection.execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       SELECT md5(g::text)::uuid, 'lk-' || g, 'BRL', ?, 1, now(), now()
         FROM generate_series(1, ?) g`,
      [ENTRIES_PER_LOOKUP_WALLET.toFixed(2), wallets],
    );
    await connection.execute(
      `WITH w AS (SELECT md5(g::text)::uuid AS wallet_id, g FROM generate_series(1, ?) g),
       t AS (
         INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount, currency, status, resulting_balance,
             processed_at, created_at)
         SELECT gen_random_uuid(), 'provider-a', 'x-' || w.g || '-' || k.k, 'provider-a:x-' || w.g || '-' || k.k,
             repeat('0', 64), w.wallet_id, 'lk', 'round-1', 'game-1', 'BET', 1.00, 'BRL', 'PROCESSED', 1.00, now(), now()
           FROM w CROSS JOIN generate_series(1, ?) k(k)
         RETURNING id, wallet_id)
       INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount,
           balance_before, balance_after, created_at)
       SELECT gen_random_uuid(), wallet_id, id, 'CREDIT', 'BRL', 1.00, 0.00, 1.00, now() FROM t`,
      [wallets, ENTRIES_PER_LOOKUP_WALLET],
    );
    await connection.execute('ANALYZE wallet_ledger_entries', []);
    const target = (await connection.execute(`SELECT md5('1')::uuid AS id`, [])) as Array<{
      id: string;
    }>;
    const walletId = target[0]?.id ?? '';
    const plan = (await connection.execute(
      `EXPLAIN SELECT balance_after FROM wallet_ledger_entries WHERE wallet_id = ? AND seq < 9223372036854775807 ORDER BY seq DESC LIMIT 1`,
      [walletId],
    )) as Array<{ 'QUERY PLAN': string }>;
    const started = performance.now();
    for (let index = 0; index < LOOKUP_REPEATS; index += 1) {
      await connection.execute(
        `SELECT balance_after FROM wallet_ledger_entries WHERE wallet_id = ? AND seq < 9223372036854775807 ORDER BY seq DESC LIMIT 1`,
        [walletId],
      );
    }
    return {
      total,
      wallets,
      millisecondsPerLookup: roundTo((performance.now() - started) / LOOKUP_REPEATS),
      plan: plan.map((row) => row['QUERY PLAN']).join(' | '),
    };
  } finally {
    await database.drop();
  }
}

const onlyLookups = process.argv.includes('--lookups');
const rounds = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? '3');
const results: Array<{
  round: number;
  withTriggers: boolean;
  samples: Record<string, ReturnType<typeof summarize>>;
}> = [];
const plannedRounds = onlyLookups ? 0 : rounds;
for (let index = 0; index < plannedRounds; index += 1) {
  // Alternate the order, so a warm cache does not favour one variant.
  const order = index % 2 === 0 ? [true, false] : [false, true];
  for (const withTriggers of order) {
    const samples = await measureVariant(withTriggers);
    results.push({
      round: index,
      withTriggers,
      samples: Object.fromEntries(
        Object.entries(samples).map(([name, values]) => [name, summarize(values)]),
      ),
    });
  }
}

const lookups = [];
for (const size of LOOKUP_SIZES) {
  lookups.push(await lookupCost(size));
}

console.log(
  JSON.stringify(
    {
      machine: {
        cpus: cpus().length,
        model: cpus()[0]?.model,
        platform: platform(),
        release: release(),
      },
      workload: {
        HOT_OPERATIONS,
        SPREAD_WALLETS,
        SPREAD_OPERATIONS_PER_WALLET,
        CONCURRENT_WORKERS,
      },
      rounds: onlyLookups ? 0 : rounds,
      results,
      lookups,
    },
    null,
    2,
  ),
);
