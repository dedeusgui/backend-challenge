import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { readAppConfig } from '../src/config/app-config';
import { ormOptions } from '../src/shared/infrastructure/database/orm-config';
import { createSqsClient, resolveQueues } from '../src/shared/infrastructure/sqs/sqs-connection';

const ROOT = join(import.meta.dir, '..');
const CONSUMER_NAME = 'wager-transactions';
const AMOUNT = '1.00';
const INITIAL_BALANCE = '100.00';
const EXPECTED_BALANCE = '99.00';
const WAIT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 300;

interface ApiClient {
  clientId: string;
  apiKey: string;
}

interface SmokeCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET';
  money: { amount: string; currency: 'BRL' };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not a JSON object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new Error(`${label} has no string ${key}`);
  return field;
}

function rowsOf(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('PostgreSQL did not return a row array');
  return value.map((row: unknown) => record(row, 'PostgreSQL row'));
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runProcess(
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function createOperator(): Promise<ApiClient> {
  const result = await runProcess([
    'bun',
    'run',
    'src/auth.ts',
    'create',
    '--name',
    `runtime-sqs-smoke-${randomUUID()}`,
    '--role',
    'OPERATOR',
  ]);
  const clientId = /^client: (\S+)$/m.exec(result.stdout)?.[1];
  const apiKey = /^key: (\S+)$/m.exec(result.stdout)?.[1];
  if (result.exitCode !== 0 || clientId === undefined || apiKey === undefined) {
    throw new Error(
      'could not create the temporary operator key; check DATABASE_URL and migrations',
    );
  }
  return { clientId, apiKey };
}

async function revokeOperator(clientId: string): Promise<void> {
  const result = await runProcess(['bun', 'run', 'src/auth.ts', 'revoke', '--client', clientId]);
  if (result.exitCode !== 0) {
    throw new Error(`could not revoke temporary operator key ${clientId}: ${result.stderr.trim()}`);
  }
}

async function api(
  baseUrl: string,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`API ${method} ${path} returned non-JSON HTTP ${response.status}`);
  }
  return { status: response.status, body: record(parsed, `API ${method} ${path}`) };
}

async function executeSql(
  orm: MikroORM,
  statement: string,
  values: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const result: unknown = await orm.em.getConnection().execute(statement, [...values]);
  return rowsOf(result);
}

async function inboxProcessed(orm: MikroORM, messageId: string): Promise<boolean> {
  const rows = await executeSql(
    orm,
    `SELECT processed_at IS NOT NULL AS processed
       FROM inbox_messages
      WHERE consumer_name = ? AND message_id = ?`,
    [CONSUMER_NAME, messageId],
  );
  return rows[0]?.processed === true;
}

async function financialSnapshot(
  orm: MikroORM,
  command: SmokeCommand,
): Promise<Record<string, unknown> | undefined> {
  const rows = await executeSql(
    orm,
    `SELECT t.id::text AS transaction_id,
            t.status,
            t.failure_code,
            w.balance::text AS wallet_balance,
            (SELECT count(*)::text
               FROM wager_transactions
              WHERE provider_id = ? AND external_transaction_id = ?) AS transaction_count,
            count(l.id)::text AS ledger_count,
            count(l.id) FILTER (WHERE l.direction = 'DEBIT' AND l.transaction_id = t.id)::text AS bet_debit_count,
            COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
              ::numeric(20,2)::text AS ledger_balance
       FROM wager_transactions t
       JOIN wallets w ON w.id = t.wallet_id
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE t.provider_id = ? AND t.external_transaction_id = ? AND t.wallet_id = ?
      GROUP BY t.id, w.id`,
    [
      command.providerId,
      command.externalTransactionId,
      command.providerId,
      command.externalTransactionId,
      command.walletId,
    ],
  );
  return rows[0];
}

async function sendCommand(
  client: SQSClient,
  queueUrl: string,
  command: SmokeCommand,
): Promise<string> {
  const messageId = randomUUID();
  const body = JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
    },
  });
  const sent = await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: command.walletId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
  assert(sent.MessageId !== undefined, 'SQS accepted no MessageId for the command');
  return messageId;
}

async function waitForWorker(
  orm: MikroORM,
  command: SmokeCommand,
  messageId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const [processed, financial] = await Promise.all([
      inboxProcessed(orm, messageId),
      financialSnapshot(orm, command),
    ]);
    if (financial?.status === 'REJECTED' || financial?.status === 'FAILED') {
      throw new Error(
        `Compose worker persisted ${String(financial.status)} (${String(financial.failure_code ?? 'no failure code')})`,
      );
    }
    if (processed && financial?.status === 'PROCESSED') return;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `deadline expired waiting for Compose worker to process SQS message ${messageId}`,
  );
}

async function verifyFinancialResult(
  orm: MikroORM,
  baseUrl: string,
  apiKey: string,
  command: SmokeCommand,
): Promise<void> {
  const snapshot = await financialSnapshot(orm, command);
  assert(snapshot !== undefined, 'PostgreSQL has no wager row for the SQS command');
  assert(snapshot.status === 'PROCESSED', `PostgreSQL status is ${String(snapshot.status)}`);
  assert(
    snapshot.transaction_count === '1',
    `expected one wager row, got ${String(snapshot.transaction_count)}`,
  );
  assert(
    snapshot.wallet_balance === EXPECTED_BALANCE,
    `PostgreSQL wallet balance is ${String(snapshot.wallet_balance)}`,
  );
  assert(
    snapshot.ledger_count === '2',
    `expected opening + one BET ledger row, got ${String(snapshot.ledger_count)}`,
  );
  assert(
    snapshot.bet_debit_count === '1',
    `expected one BET debit, got ${String(snapshot.bet_debit_count)}`,
  );
  assert(
    snapshot.ledger_balance === EXPECTED_BALANCE,
    `PostgreSQL ledger sum is ${String(snapshot.ledger_balance)}`,
  );

  const transactionId = stringField(snapshot, 'transaction_id', 'PostgreSQL snapshot');
  const wallet = await api(baseUrl, apiKey, 'GET', `/wallets/${command.walletId}`);
  assert(wallet.status === 200, `GET wallet returned HTTP ${wallet.status}`);
  assert(
    stringField(record(wallet.body.balance, 'wallet balance'), 'amount', 'wallet balance') ===
      EXPECTED_BALANCE,
    'API wallet balance is not 99.00',
  );

  const transaction = await api(
    baseUrl,
    apiKey,
    'GET',
    `/providers/${encodeURIComponent(command.providerId)}/wagering/transactions/${encodeURIComponent(command.externalTransactionId)}`,
  );
  assert(transaction.status === 200, `GET transaction returned HTTP ${transaction.status}`);
  assert(
    transaction.body.status === 'PROCESSED',
    `API transaction status is ${String(transaction.body.status)}`,
  );
  assert(
    transaction.body.transactionId === transactionId,
    'API and PostgreSQL transaction ids differ',
  );

  const ledger = await api(baseUrl, apiKey, 'GET', `/wallets/${command.walletId}/ledger?limit=50`);
  assert(ledger.status === 200, `GET ledger returned HTTP ${ledger.status}`);
  assert(Array.isArray(ledger.body.entries), 'API ledger response has no entries array');
  const entries = ledger.body.entries.map((entry: unknown) => record(entry, 'ledger entry'));
  assert(entries.length === 2, `API ledger has ${entries.length} entries instead of two`);
  const debits = entries.filter(
    (entry) => entry.direction === 'DEBIT' && entry.transactionId === transactionId,
  );
  assert(debits.length === 1, `API ledger has ${debits.length} debit entries for the BET`);
}

async function diagnostics(
  orm: MikroORM | undefined,
  client: SQSClient | undefined,
  queueUrl: string | undefined,
  command: SmokeCommand | undefined,
  messageIds: readonly string[],
): Promise<string> {
  const result: Record<string, unknown> = { messageIds };
  if (orm !== undefined && command !== undefined) {
    try {
      result.financial = await financialSnapshot(orm, command);
      result.inbox = await Promise.all(
        messageIds.map(async (messageId) => ({
          messageId,
          processed: await inboxProcessed(orm, messageId),
        })),
      );
    } catch (error) {
      result.databaseDiagnosticError = String(error);
    }
  }
  if (client !== undefined && queueUrl !== undefined) {
    try {
      const attributes = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      result.queue = attributes.Attributes;
    } catch (error) {
      result.queueDiagnosticError = String(error);
    }
  }
  for (const commandArgs of [
    ['docker', 'compose', 'ps', '--all'],
    ['docker', 'compose', 'logs', '--timestamps', '--no-color', '--tail', '80', 'worker'],
  ]) {
    try {
      const output = await runProcess(commandArgs);
      result[commandArgs.includes('logs') ? 'workerLogs' : 'composeServices'] =
        `${output.stdout}${output.stderr}`.trim();
    } catch (error) {
      result.composeDiagnosticError = String(error);
    }
  }
  return JSON.stringify(result, null, 2);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const baseUrl = process.env.API_URL;
  const sqsEndpoint = process.env.SQS_ENDPOINT;
  assert(databaseUrl !== undefined && databaseUrl.trim() !== '', 'DATABASE_URL is required');
  assert(baseUrl !== undefined && baseUrl.trim() !== '', 'API_URL is required');
  assert(
    sqsEndpoint !== undefined && sqsEndpoint.trim() !== '',
    'SQS_ENDPOINT is required for the Compose smoke',
  );
  const timeoutMs = Number(process.env.SQS_WORKER_SMOKE_TIMEOUT_MS ?? WAIT_TIMEOUT_MS);
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    'SQS_WORKER_SMOKE_TIMEOUT_MS must be a positive integer',
  );

  let orm: MikroORM | undefined;
  let client: SQSClient | undefined;
  let operator: ApiClient | undefined;
  let command: SmokeCommand | undefined;
  let queueUrl: string | undefined;
  const messageIds: string[] = [];
  let failure: unknown;

  try {
    const config = readAppConfig(process.env);
    orm = await MikroORM.init(ormOptions(databaseUrl));
    client = createSqsClient(config.sqs);
    queueUrl = (await resolveQueues(client, config.sqs)).commandQueueUrl;
    operator = await createOperator();

    const tag = randomUUID();
    const playerId = randomUUID();
    const externalTransactionId = `runtime-sqs-${tag}`;
    command = {
      providerId: 'runtime-smoke',
      externalTransactionId,
      idempotencyKey: `runtime-smoke:${externalTransactionId}`,
      playerId,
      walletId: '',
      roundId: `round-${tag}`,
      gameId: 'runtime-smoke',
      kind: 'BET',
      money: { amount: AMOUNT, currency: 'BRL' },
    };

    const opened = await api(baseUrl, operator.apiKey, 'POST', '/wallets', {
      playerId,
      initialBalance: { amount: INITIAL_BALANCE, currency: 'BRL' },
    });
    assert(opened.status === 201, `POST wallet returned HTTP ${opened.status}`);
    command = { ...command, walletId: stringField(opened.body, 'id', 'opened wallet') };

    const firstMessageId = await sendCommand(client, queueUrl, command);
    messageIds.push(firstMessageId);
    await waitForWorker(orm, command, firstMessageId, timeoutMs);
    await verifyFinancialResult(orm, baseUrl, operator.apiKey, command);

    const replayMessageId = await sendCommand(client, queueUrl, command);
    messageIds.push(replayMessageId);
    await waitForWorker(orm, command, replayMessageId, timeoutMs);
    await verifyFinancialResult(orm, baseUrl, operator.apiKey, command);

    console.log(
      `SQS worker smoke passed: two distinct FIFO messages were processed; one BET debit; balance ${EXPECTED_BALANCE}.`,
    );
  } catch (error) {
    failure = error;
    const details = await diagnostics(orm, client, queueUrl, command, messageIds);
    console.error(`SQS worker smoke diagnostics:\n${details}`);
  } finally {
    const cleanupErrors: unknown[] = [];
    if (operator !== undefined) {
      try {
        await revokeOperator(operator.clientId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    client?.destroy();
    if (orm !== undefined) {
      try {
        await orm.close(true);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      failure =
        failure === undefined
          ? new AggregateError(cleanupErrors, 'SQS worker smoke cleanup failed')
          : new AggregateError([failure, ...cleanupErrors], 'SQS worker smoke and cleanup failed');
    }
  }

  if (failure !== undefined) throw failure;
}

await main();
