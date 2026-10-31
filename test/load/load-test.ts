/**
 * Load test, an optional differential of the challenge (section 14). It runs the real stack as
 * independent processes: three API processes and two workers, sharing one PostgreSQL and one
 * LocalStack. It reports throughput, client-side latency percentiles, the status mix, the lost
 * lock races, the outbox lag, and whether the invariant `wallet.balance == ledger sum` still holds
 * for every wallet. It writes docs/LOAD_TEST_RESULTS.md.
 *
 * Run it with `bun run test:load`. It is not part of `check:all`: it takes minutes, and its numbers
 * describe the machine it runs on, not a target. Tune it with LOAD_OPERATIONS, LOAD_CONCURRENCY
 * and LOAD_WALLETS.
 */
import { writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CreateApiClient } from '../../src/modules/auth/application/create-api-client.use-case';
import { MikroOrmApiClientRepository } from '../../src/modules/auth/infrastructure/mikro-orm-api-client.repository';
import { ProcessCluster, type ManagedProcess } from '../concurrency/support/process-cluster';

const OPERATIONS = Number(process.env.LOAD_OPERATIONS ?? 4000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 64);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 50);
const API_PROCESSES = 3;
const WORKER_PROCESSES = 2;
/** Share of operations aimed at wallet 0, which every lane contends for. */
const HOT_SHARE = 0.1;
/** Share of operations that re-send an earlier request with its original key. */
const REPLAY_SHARE = 0.05;
const STARTING_BALANCE = '1000.00';
const STAKE = '5.00';
const REPORT_PATH = `${import.meta.dir}/../../docs/LOAD_TEST_RESULTS.md`;

interface Operation {
  key: string;
  body: string;
  hot: boolean;
  replay: boolean;
}

interface Sample {
  latencyMs: number;
  status: number | 'ERROR';
  hot: boolean;
  replay: boolean;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] as number;
}

function summarise(samples: number[]): string {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction: number) => percentile(sorted, fraction).toFixed(1);
  return `${sorted.length} | ${at(0.5)} | ${at(0.95)} | ${at(0.99)} | ${sorted.at(-1)?.toFixed(1) ?? 'n/a'}`;
}

function metricsLineOf(managed: ManagedProcess): Record<string, unknown> {
  const line = managed
    .recentOutput()
    .split('\n')
    .find((candidate) => candidate.includes('"type":"metrics"'));
  if (line === undefined) throw new Error(`${managed.name} printed no metrics`);
  return JSON.parse(line) as Record<string, unknown>;
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

async function main(): Promise<number> {
  const cluster = await ProcessCluster.create();
  try {
    const scalar = async (sql: string, params: unknown[] = []): Promise<string> => {
      const rows = (await cluster.database.orm.em.getConnection().execute(sql, params)) as Array<
        Record<string, string>
      >;
      return Object.values(rows[0] ?? {})[0] ?? '';
    };
    const clients = new CreateApiClient({
      repository: new MikroOrmApiClientRepository(cluster.database.orm),
      clock: () => new Date(),
      newId: randomUUID,
    });
    const operatorKey = (await clients.execute({ name: 'operator', role: 'OPERATOR' })).apiKey;
    const providerKey = (
      await clients.execute({ name: 'provider a', role: 'PROVIDER', providerId: 'provider-a' })
    ).apiKey;
    const apis: string[] = [];
    for (let index = 0; index < API_PROCESSES; index += 1) {
      apis.push(await cluster.startApi(`api-${index + 1}`));
    }
    const workers = Array.from({ length: WORKER_PROCESSES }, (_, index) =>
      cluster.startWorker(`worker-${index + 1}`),
    );

    const wallets: Array<{ id: string; playerId: string }> = [];
    for (let index = 0; index < WALLETS; index += 1) {
      const playerId = randomUUID();
      const response = await fetch(`${apis[index % apis.length] as string}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: STARTING_BALANCE, currency: 'BRL' },
        }),
      });
      wallets.push({ id: ((await response.json()) as { id: string }).id, playerId });
    }

    const operations: Operation[] = [];
    for (let index = 0; index < OPERATIONS; index += 1) {
      const replayOf = operations.length > 0 && Math.random() < REPLAY_SHARE;
      if (replayOf) {
        const original = operations[Math.floor(Math.random() * operations.length)] as Operation;
        operations.push({ ...original, replay: true });
        continue;
      }
      const hot = Math.random() < HOT_SHARE;
      const wallet = hot
        ? (wallets[0] as (typeof wallets)[number])
        : (wallets[Math.floor(Math.random() * wallets.length)] as (typeof wallets)[number]);
      const externalTransactionId = `load-${index}-${randomUUID()}`;
      operations.push({
        key: `provider-a:${externalTransactionId}`,
        body: JSON.stringify({
          providerId: 'provider-a',
          externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-987',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: STAKE, currency: 'BRL' },
        }),
        hot,
        replay: false,
      });
    }

    const samples: Sample[] = [];
    let next = 0;
    const lane = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= operations.length) return;
        const operation = operations[index] as Operation;
        const api = apis[index % apis.length] as string;
        const started = performance.now();
        try {
          const response = await fetch(`${api}/wagering/transactions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${providerKey}`,
              'idempotency-key': operation.key,
            },
            body: operation.body,
          });
          await response.text();
          samples.push({
            latencyMs: performance.now() - started,
            status: response.status,
            hot: operation.hot,
            replay: operation.replay,
          });
        } catch {
          samples.push({
            latencyMs: performance.now() - started,
            status: 'ERROR',
            hot: operation.hot,
            replay: operation.replay,
          });
        }
      }
    };
    const started = performance.now();
    await Promise.all(Array.from({ length: CONCURRENCY }, () => lane()));
    const elapsedSeconds = (performance.now() - started) / 1000;

    await waitUntil(
      async () =>
        (await scalar(`SELECT count(*)::text FROM outbox_messages WHERE published_at IS NULL`)) ===
        '0',
      180_000,
    );

    const violations = Number(
      await scalar(
        `SELECT count(*)::text FROM wallets w
          WHERE w.balance <> (SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
                                FROM wallet_ledger_entries l WHERE l.wallet_id = w.id)
             OR w.balance < 0`,
      ),
    );
    const duplicateBets = Number(
      await scalar(
        `SELECT count(*)::text FROM (SELECT external_transaction_id FROM wager_transactions GROUP BY external_transaction_id HAVING count(*) > 1) d`,
      ),
    );

    const apiMetrics = await Promise.all(
      apis.map(async (api) => {
        const response = await fetch(`${api}/metrics`, {
          headers: { authorization: `Bearer ${operatorKey}` },
        });
        return ((await response.json()) as { counters: Record<string, number> }).counters;
      }),
    );
    const sumCounter = (name: string) =>
      apiMetrics.reduce((sum, counters) => sum + (counters[name] ?? 0), 0);

    for (const worker of workers) {
      worker.process.kill('SIGTERM');
      await worker.process.exited;
    }
    const workerMetrics = workers.map(metricsLineOf) as Array<{
      counters: Record<string, number>;
      summaries: Record<string, { count: number; sum: number; max: number }>;
    }>;
    const lag = workerMetrics.reduce(
      (total, metrics) => {
        const summary = metrics.summaries['outbox_lag_seconds'];
        return summary === undefined
          ? total
          : {
              count: total.count + summary.count,
              sum: total.sum + summary.sum,
              max: Math.max(total.max, summary.max),
            };
      },
      { count: 0, sum: 0, max: 0 },
    );
    const published = workerMetrics.reduce(
      (total, metrics) => total + (metrics.counters['outbox_published_total'] ?? 0),
      0,
    );

    const answered = samples.filter((sample) => sample.status !== 'ERROR');
    const statusCounts = new Map<string, number>();
    for (const sample of samples) {
      const key = String(sample.status);
      statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
    }
    const serverErrors = samples.filter(
      (sample) =>
        sample.status === 'ERROR' || (typeof sample.status === 'number' && sample.status >= 500),
    ).length;
    const outcome = [...statusCounts.entries()]
      .sort()
      .map(([status, count]) => `| ${status} | ${count} |`)
      .join('\n');

    const report = `# Load test results

Generated by \`bun run test:load\` on ${new Date().toISOString()}. This is an optional
differential. The numbers describe this machine and this run. They are not a capacity claim.

## Environment

| Item | Value |
| --- | --- |
| Platform | ${platform()} ${release()} (${arch()}) |
| CPUs | ${cpus().length} |
| Memory | ${(totalmem() / 1024 ** 3).toFixed(1)} GiB |
| Bun | ${Bun.version} |
| PostgreSQL | 17 (Compose image \`postgres:17-alpine\`) |
| LocalStack | 4.14 (Compose image) |
| Processes | ${API_PROCESSES} API processes, ${WORKER_PROCESSES} workers, all on this machine |

## Methodology

- ${OPERATIONS} operations, ${CONCURRENCY} concurrent lanes, ${WALLETS} wallets opened with ${STARTING_BALANCE} BRL.
- Each lane sends one request at a time, and the lanes round-robin over the ${API_PROCESSES} API processes.
- ${Math.round(HOT_SHARE * 100)}% of the operations contend for one hot wallet. ${Math.round(REPLAY_SHARE * 100)}% re-send an earlier request with its original key.
- Every operation is a BET of ${STAKE} BRL. A business rejection (422, insufficient balance) is an expected answer, not an error.
- Latency is measured by the client, from sending to reading the body. The server summaries have only count, sum and max, so the percentiles below are client-side.
- After the run, the outbox is drained, and the invariant \`wallet.balance == ledger sum\` is checked for every wallet.

## Results

| Measure | Value |
| --- | --- |
| Duration of the load phase | ${elapsedSeconds.toFixed(2)} s |
| Throughput | ${(samples.length / elapsedSeconds).toFixed(1)} requests/s |
| Errors (network failure or 5xx) | ${serverErrors} of ${samples.length} (${((serverErrors / samples.length) * 100).toFixed(2)}%) |
| Lock races lost and retried (\`concurrency_conflicts_total\`) | ${sumCounter('concurrency_conflicts_total')} |
| Idempotent replays served (\`idempotent_replays_total\`) | ${sumCounter('idempotent_replays_total')} |
| Outbox events published | ${published} |
| Outbox lag, average and maximum (s, server summary) | ${lag.count === 0 ? 'n/a' : (lag.sum / lag.count).toFixed(3)} / ${lag.max.toFixed(3)} |
| Wallets where \`balance != ledger\` or balance < 0 | ${violations} |
| Transaction ids processed more than once | ${duplicateBets} |

### Client-side latency, milliseconds

| Group | Requests | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| All answered requests | ${summarise(answered.map((sample) => sample.latencyMs))} |
| Distinct wallets | ${summarise(answered.filter((sample) => !sample.hot).map((sample) => sample.latencyMs))} |
| Hot wallet | ${summarise(answered.filter((sample) => sample.hot).map((sample) => sample.latencyMs))} |
| Replays | ${summarise(answered.filter((sample) => sample.replay).map((sample) => sample.latencyMs))} |

### Status mix

| Status | Count |
| --- | ---: |
${outcome}

## Verdict

${violations === 0 && duplicateBets === 0 && serverErrors === 0 ? 'The invariant held for every wallet, no transaction was processed twice, and no request failed with an error.' : 'At least one check failed. See the counts above before drawing any conclusion.'}
`;
    await writeFile(REPORT_PATH, report);
    console.log(report);
    return violations === 0 && duplicateBets === 0 && serverErrors === 0 ? 0 : 1;
  } finally {
    await cluster.close();
  }
}

process.exitCode = await main();
