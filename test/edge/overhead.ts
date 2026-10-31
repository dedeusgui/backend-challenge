/**
 * Measures what the edge costs and what its limits do. Run it against a running stack:
 *
 *   OPERATOR_KEY=<key> WALLET_ID=<uuid> bun run test/edge/overhead.ts <label> [base-url]
 *
 * It sends the same reads in two phases. A sequential phase gives latency with no queueing. A concurrent
 * phase gives the answers per second and the share refused with 429. Compare a run against the API
 * directly (the default mode) with a run through the edge with its limits raised (the proxy's cost), and
 * with the edge's default limits (the quota's effect). The numbers describe the host that ran them.
 */

export {};

const label = process.argv[2] ?? 'run';
const baseUrl = process.argv[3] ?? 'http://localhost:3000';
const key = process.env.OPERATOR_KEY;
const walletId = process.env.WALLET_ID;
if (key === undefined || walletId === undefined) {
  throw new Error('OPERATOR_KEY and WALLET_ID are required');
}
const sequentialCount = Number(process.env.SEQUENTIAL ?? 500);
const concurrency = Number(process.env.CONCURRENCY ?? 8);
const concurrentSeconds = Number(process.env.SECONDS ?? 10);
const path = `/wallets/${walletId}`;

async function once(): Promise<{ status: number; ms: number }> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  await response.arrayBuffer();
  return { status: response.status, ms: performance.now() - started };
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? Number.NaN;
}

// Latency is taken over the answers that were not refused, so a fast 429 does not look like a fast API.
const sequential: number[] = [];
const sequentialCounts = new Map<number, number>();
for (let index = 0; index < sequentialCount; index += 1) {
  const result = await once();
  sequentialCounts.set(result.status, (sequentialCounts.get(result.status) ?? 0) + 1);
  if (result.status !== 429) {
    sequential.push(result.ms);
  }
}
sequential.sort((left, right) => left - right);

const counts = new Map<number, number>();
const deadline = performance.now() + concurrentSeconds * 1000;
let answered = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline) {
      const result = await once();
      answered += 1;
      counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
    }
  }),
);

console.log(
  JSON.stringify({
    label,
    baseUrl,
    sequential: {
      requests: sequentialCount,
      answered: sequential.length,
      statuses: Object.fromEntries([...sequentialCounts.entries()].sort(([a], [b]) => a - b)),
      p50Ms: +percentile(sequential, 0.5).toFixed(2),
      p95Ms: +percentile(sequential, 0.95).toFixed(2),
      p99Ms: +percentile(sequential, 0.99).toFixed(2),
    },
    concurrent: {
      concurrency,
      seconds: concurrentSeconds,
      requests: answered,
      perSecond: +(answered / concurrentSeconds).toFixed(1),
      statuses: Object.fromEntries([...counts.entries()].sort(([a], [b]) => a - b)),
      refusedShare: +(((counts.get(429) ?? 0) / Math.max(1, answered)) * 100).toFixed(1),
    },
  }),
);
