import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { connect, type Socket } from 'bun';

/**
 * Protected mode (docker-compose.protected.yml). These tests need the stack that `bun run edge:up` starts,
 * and they fail with a clear message when it is not running. They prove what the edge promises: the API has
 * no public port, a client over its limit gets 429 with a JSON body, health checks are not limited,
 * spoofed forwarding headers do not change a client's quota, separate client addresses have separate
 * quotas, and the financial behaviour is the same through the edge.
 *
 * The quotas are per client address. The client containers below run on the compose network, so each one
 * has its own address, and that is the evidence of isolation. Requests from the host all share the Docker
 * gateway address, so the host is not used to show isolation.
 */

const REPO = join(import.meta.dir, '..', '..');
const EDGE_HOST_PORT = process.env.EDGE_HOST_PORT ?? '3000';
const PUBLIC_URL = process.env.EDGE_URL ?? `http://localhost:${EDGE_HOST_PORT}`;
const NETWORK = process.env.EDGE_NETWORK ?? 'backend-challenge_default';
const COMPOSE = [
  'docker',
  'compose',
  '-f',
  'docker-compose.yml',
  '-f',
  'docker-compose.protected.yml',
];
const CLIENT_IMAGE = 'nginx:1.27-alpine';
/** The read quota refills at 50 per second, and its burst is 100. Three seconds restore a full burst. */
const QUOTA_WINDOW_MS = 3_000;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function run(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

async function compose(args: string[]) {
  return run([...COMPOSE, ...args]);
}

/** Runs a shell script in a client container on the compose network. The container has its own address. */
async function fromClient(script: string): Promise<string> {
  const result = await run([
    'docker',
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    '--network',
    NETWORK,
    CLIENT_IMAGE,
    '-c',
    script,
  ]);
  if (result.code !== 0) {
    throw new Error(`client container failed (${result.code}): ${result.stderr}`);
  }
  return result.stdout;
}

async function createKey(
  role: 'OPERATOR' | 'PROVIDER',
  name: string,
  providerId?: string,
): Promise<string> {
  const args = ['--name', name, '--role', role];
  if (providerId !== undefined) args.push('--provider', providerId);
  const result = await compose(['exec', '-T', 'api', 'bun', 'run', 'auth:create', '--', ...args]);
  const match = /^key: (.+)$/m.exec(result.stdout);
  if (result.code !== 0 || match?.[1] === undefined) {
    throw new Error(`could not create an API key: ${result.stderr || result.stdout}`);
  }
  return match[1];
}

async function send(
  method: string,
  path: string,
  options: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Headers; json: unknown }> {
  const response = await fetch(`${PUBLIC_URL}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.key === undefined ? {} : { authorization: `Bearer ${options.key}` }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    json: text === '' ? undefined : JSON.parse(text),
  };
}

function codeOf(json: unknown): unknown {
  if (typeof json !== 'object' || json === null || !('error' in json)) return undefined;
  const { error } = json;
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** Sends requests at once, and returns every answer. */
async function burst(count: number, path: string, headers: Record<string, string> = {}) {
  return Promise.all(Array.from({ length: count }, () => send('GET', path, { headers })));
}

let operatorKey = '';
let providerKey = '';
let walletId = '';
const readPath = '/wallets/00000000-0000-0000-0000-000000000000';

describe('protected mode: the edge is the only way in', () => {
  test('the stack is up, and every service is running', async () => {
    const health = await send('GET', '/health/live').catch((error: unknown) => {
      throw new Error(
        `the protected stack is not reachable at ${PUBLIC_URL}; start it with bun run edge:up (${String(error)})`,
      );
    });
    expect(health.status).toBe(200);
    const ps = await compose(['ps', '--format', 'json']);
    expect(ps.code).toBe(0);
    for (const service of ['api', 'edge', 'worker', 'postgres', 'localstack']) {
      expect(ps.stdout).toContain(`"Service":"${service}"`);
    }
  });

  test('the API publishes no port of its own: the edge is the only public entry', async () => {
    const inspect = await run([
      'docker',
      'inspect',
      'backend-challenge-api-1',
      '--format',
      '{{json .NetworkSettings.Ports}}',
    ]);

    expect(inspect.code).toBe(0);
    const ports = JSON.parse(inspect.stdout) as Record<string, unknown>;
    expect(ports['3000/tcp']).toBeNull();
    const edge = await run([
      'docker',
      'inspect',
      'backend-challenge-edge-1',
      '--format',
      '{{json .NetworkSettings.Ports}}',
    ]);
    // The edge binds loopback only. A selected host port lets the suite run beside other local services.
    expect(JSON.parse(edge.stdout)).toMatchObject({
      '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: EDGE_HOST_PORT }],
    });
  });

  test('PostgreSQL and LocalStack publish no port in protected mode, at run time', async () => {
    for (const container of ['backend-challenge-postgres-1', 'backend-challenge-localstack-1']) {
      const inspect = await run([
        'docker',
        'inspect',
        container,
        '--format',
        '{{json .NetworkSettings.Ports}}',
      ]);

      expect(inspect.code).toBe(0);
      const ports = JSON.parse(inspect.stdout) as Record<string, unknown>;
      for (const [port, binding] of Object.entries(ports)) {
        expect({ container, port, binding }).toEqual({ container, port, binding: null });
      }
    }
  });

  test('the API is reachable on the internal network, so only the edge stands in front of it', async () => {
    const internal = await fromClient('wget -q -O - http://api:3000/health/live');

    expect(internal).toContain('"status":"ok"');
  });

  test('a legitimate client below its limit is served, and wallet operations keep their financial result', async () => {
    operatorKey = await createKey('OPERATOR', `edge-operator-${randomUUID()}`);
    providerKey = await createKey('PROVIDER', `edge-provider-${randomUUID()}`, 'provider-a');
    const playerId = randomUUID();

    const opened = await send('POST', '/wallets', {
      key: operatorKey,
      body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
    });
    expect(opened.status).toBe(201);
    walletId = String((opened.json as { id: string }).id);

    const submission = {
      providerId: 'provider-a',
      externalTransactionId: `edge-${randomUUID()}`,
      playerId,
      walletId,
      roundId: 'round-edge',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const headers = { 'idempotency-key': `provider-a:${submission.externalTransactionId}` };
    const first = await send('POST', '/wagering/transactions', {
      key: providerKey,
      body: submission,
      headers,
    });
    const replay = await send('POST', '/wagering/transactions', {
      key: providerKey,
      body: submission,
      headers,
    });
    const balance = await send('GET', `/wallets/${walletId}`, { key: operatorKey });
    const ledger = await send('GET', `/wallets/${walletId}/ledger?limit=10`, { key: operatorKey });

    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00' },
      idempotentReplay: false,
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ idempotentReplay: true, balance: { amount: '75.00' } });
    expect(balance.json).toMatchObject({ balance: { amount: '75.00' } });
    expect((ledger.json as { entries: unknown[] }).entries).toHaveLength(2);
  });

  test('a request without a key is refused by the API, through the edge, with its own code', async () => {
    const result = await send('GET', `/wallets/${walletId}`);

    expect(result.status).toBe(401);
    expect(codeOf(result.json)).toBe('UNAUTHENTICATED');
  });

  test('a burst above the limit is answered 429, as JSON, with Retry-After', async () => {
    await sleep(QUOTA_WINDOW_MS);

    const answers = await burst(250, readPath);
    const limited = answers.find((answer) => answer.status === 429);

    expect(limited).toBeDefined();
    expect(limited?.headers.get('retry-after')).toBe('1');
    expect(codeOf(limited?.json)).toBe('RATE_LIMITED');
  });

  test('health checks are answered while the client is throttled', async () => {
    await burst(250, readPath);

    const statuses = await Promise.all(
      Array.from({ length: 5 }, () => send('GET', '/health/live').then((result) => result.status)),
    );

    expect(statuses).toEqual([200, 200, 200, 200, 200]);
  });

  test('the limit recovers once its window has passed', async () => {
    await sleep(QUOTA_WINDOW_MS);

    const result = await send('GET', readPath);

    expect(result.status).not.toBe(429);
  });

  test('spoofed forwarding headers do not change the quota, because the limit is keyed on the socket address', async () => {
    await sleep(QUOTA_WINDOW_MS);
    const spoofed = (index: number) => ({
      'x-forwarded-for': `10.${index % 250}.${(index * 7) % 250}.1`,
      'x-real-ip': `192.168.${index % 250}.9`,
      forwarded: `for=203.0.113.${index % 250}`,
    });

    const statuses = await Promise.all(
      Array.from({ length: 250 }, (_, index) =>
        send('GET', readPath, { headers: spoofed(index) }).then((r) => r.status),
      ),
    );

    // A quota that the headers could reset would let most of these through. The burst allows about 100.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(100);
  });

  test('clients at different addresses have separate quotas: one client over its limit does not limit another', async () => {
    await sleep(QUOTA_WINDOW_MS);
    // The flood lasts four seconds and keeps the quota empty. The quiet client starts inside that time, so
    // a quota shared between the two addresses would refuse it. A flood that ended first would prove nothing.
    const flood = `end=$(( $(date +%s) + 4 )); while [ $(date +%s) -lt $end ]; do seq 1 30 | xargs -P 30 -I{} sh -c 'wget -S -q -O /dev/null "http://edge:8080${readPath}" 2>&1 | head -n 1'; done`;
    const quietRequests = `sleep 1; seq 1 10 | xargs -P 10 -I{} sh -c 'wget -S -q -O /dev/null "http://edge:8080${readPath}" 2>&1 | head -n 1'`;

    const [noisy, quiet] = await Promise.all([fromClient(flood), fromClient(quietRequests)]);

    expect(noisy.split('\n').filter((line) => line.includes(' 429 ')).length).toBeGreaterThan(0);
    expect(quiet.split('\n').filter((line) => line.includes(' 429 '))).toHaveLength(0);
    expect(quiet.split('\n').filter((line) => line.includes(' 401 ')).length).toBe(10);
  }, 30_000);

  test('a flood of open connections is limited: a request beyond the connection limit is 429', async () => {
    await sleep(QUOTA_WINDOW_MS);
    const holders: Socket<undefined>[] = [];
    try {
      for (let index = 0; index < 60; index += 1) {
        const socket = await connect({
          hostname: 'localhost',
          port: Number(EDGE_HOST_PORT),
          socket: { data() {}, error() {}, close() {} },
        });
        // Complete headers and a body that never comes: the request stays in progress, and so does its connection.
        socket.write(
          `GET ${readPath} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${operatorKey}\r\nContent-Length: 10\r\n\r\n`,
        );
        holders.push(socket);
      }
      await sleep(500);

      const result = await send('GET', readPath);

      expect(result.status).toBe(429);
    } finally {
      for (const socket of holders) socket.end();
    }
  });
});
