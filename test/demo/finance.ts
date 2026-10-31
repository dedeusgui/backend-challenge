/**
 * Demonstration 1: the financial flow, against a running API (default mode, port 3000).
 *
 *   bun run demo:finance
 *
 * It opens a wallet with 100.00, then runs a BET, a WIN, a BET and its REFUND, and a ROLLBACK of the WIN. Each
 * step prints the balance and the answer, and checks it against the rules. It then reads the ledger, checks that
 * its sum is the balance, and runs the reconciliation. It needs `.env` (DATABASE_URL), because it creates its own
 * API keys with the auth command, and the stack must be running (`docker compose up --build`).
 */

export {};

const baseUrl = process.env.API_URL ?? 'http://localhost:3000';
const tag = Date.now().toString(36);

/** Narrows an answer to an object, so that its fields are read as unknown, never trusted as a type. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('demonstration failed: the API answered something that is not a JSON object');
  }
  return Object.fromEntries(Object.entries(value));
}

/** The amount of a money value in an answer. A missing amount is a failure, not a zero. */
function amountOf(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'amount' in value &&
    typeof value.amount === 'string'
  ) {
    return value.amount;
  }
  throw new Error('demonstration failed: an answer has no amount');
}

async function createKey(
  name: string,
  role: 'OPERATOR' | 'PROVIDER',
  providerId?: string,
): Promise<string> {
  const args = ['run', 'src/auth.ts', 'create', '--name', `${name}-${tag}`, '--role', role];
  if (providerId !== undefined) args.push('--provider', providerId);
  const child = Bun.spawn(['bun', ...args], {
    cwd: `${import.meta.dir}/../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const match = /^key: (.+)$/m.exec(output);
  if ((await child.exited) !== 0 || match?.[1] === undefined) {
    throw new Error(
      'could not create a key: check DATABASE_URL in .env and that the database is migrated',
    );
  }
  return match[1];
}

async function call(
  method: string,
  path: string,
  key: string,
  body?: unknown,
  idempotencyKey?: string,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: asRecord(await response.json()) };
}

function must(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`demonstration failed: ${message}`);
  }
  console.log(`  ok: ${message}`);
}

const operator = await createKey('demo-operator', 'OPERATOR');
const provider = await createKey('demo-provider', 'PROVIDER', 'provider-a');
const playerId = `demo-player-${tag}`;

console.log('1. open a wallet with 100.00 BRL');
const opened = await call('POST', '/wallets', operator, {
  playerId,
  initialBalance: { amount: '100.00', currency: 'BRL' },
});
const walletId = String(opened.json.id);
must(
  opened.status === 201 && amountOf(opened.json.balance) === '100.00',
  'wallet opened at 100.00',
);

async function submit(
  label: string,
  externalId: string,
  kind: string,
  amount: string,
  reference?: string,
) {
  const externalTransactionId = `${externalId}-${tag}`;
  const body = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: `round-${tag}`,
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference === undefined ? {} : { referenceExternalTransactionId: `${reference}-${tag}` }),
  };
  const result = await call(
    'POST',
    '/wagering/transactions',
    provider,
    body,
    `provider-a:${externalTransactionId}`,
  );
  console.log(
    `${label}: ${result.status} ${String(result.json.status)} balance ${amountOf(result.json.balance)}`,
  );
  return result;
}

console.log('2. a BET of 25.00, a WIN of 40.00 on it, then a BET of 10.00 and its REFUND');
const bet1 = await submit('  BET 25.00', 'bet-1', 'BET', '25.00');
must(bet1.status === 201 && amountOf(bet1.json.balance) === '75.00', 'the BET debits to 75.00');
const win1 = await submit('  WIN 40.00 on bet-1', 'win-1', 'WIN', '40.00', 'bet-1');
must(amountOf(win1.json.balance) === '115.00', 'the WIN credits to 115.00');
await submit('  BET 10.00', 'bet-2', 'BET', '10.00');
const refund = await submit('  REFUND 10.00 of bet-2', 'refund-2', 'REFUND', '10.00', 'bet-2');
must(amountOf(refund.json.balance) === '115.00', 'the REFUND returns the stake to 115.00');

console.log('3. a ROLLBACK of the WIN takes its 40.00 back, once');
const rollback = await submit('  ROLLBACK of win-1', 'rollback-1', 'ROLLBACK', '40.00', 'win-1');
must(amountOf(rollback.json.balance) === '75.00', 'the ROLLBACK returns the balance to 75.00');
const again = await submit('  ROLLBACK of win-1 again', 'rollback-2', 'ROLLBACK', '40.00', 'win-1');
must(
  again.json.failureCode === 'REFERENCE_ALREADY_REVERSED',
  'a second ROLLBACK is REJECTED with REFERENCE_ALREADY_REVERSED',
);

console.log('4. the same BET sent again is a replay, with the balance it was observed with');
const replayBody = {
  providerId: 'provider-a',
  externalTransactionId: `bet-1-${tag}`,
  playerId,
  walletId,
  roundId: `round-${tag}`,
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};
const replay = await call(
  'POST',
  '/wagering/transactions',
  provider,
  replayBody,
  `provider-a:bet-1-${tag}`,
);
must(
  replay.status === 200 && replay.json.idempotentReplay === true,
  'the replay is 200 with idempotentReplay true',
);
must(
  amountOf(replay.json.balance) === '75.00',
  'the replay reports the balance observed when the BET was applied',
);

console.log('5. the ledger sums to the balance, and reconciliation agrees');
const ledger = await call('GET', `/wallets/${walletId}/ledger?limit=50`, operator);
const entries: unknown[] = Array.isArray(ledger.json.entries) ? ledger.json.entries : [];
const sum = entries.reduce<number>((total, entry) => {
  const record = asRecord(entry);
  const sign = record.direction === 'CREDIT' ? 1 : -1;
  return total + sign * Number(amountOf(record.amount));
}, 0);
must(
  entries.length === 6,
  `the ledger has the opening and five operations (${entries.length} entries)`,
);
must(sum.toFixed(2) === '75.00', 'the signed sum of the ledger is 75.00');
const reconciliation = await call('POST', `/wallets/${walletId}/reconciliation`, operator, {
  walletId,
  storedBalance: { amount: '75.00', currency: 'BRL' },
  calculatedBalance: { amount: '75.00', currency: 'BRL' },
});
must(reconciliation.json.consistent === true, 'reconciliation reports the wallet consistent');
console.log('done: every balance above was checked against the rules.');
