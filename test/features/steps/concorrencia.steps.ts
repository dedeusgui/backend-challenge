import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { OutboxPublisher } from '../../../src/modules/messaging/application/outbound/outbox-publisher';
import type {
  OutboxTransport,
  OutboxTransportFailure,
  OutboxTransportMessage,
} from '../../../src/modules/messaging/application/ports/outbox-transport';
import { MikroOrmOutboxStore } from '../../../src/modules/messaging/infrastructure/mikro-orm-outbox.store';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { ProcessWagerTransaction } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import {
  assertReady,
  assertWallet,
  command,
  currentBalance,
  type WorldData,
} from './finance.steps';

const scenarios = new WeakMap<WorldData, { sent: string[]; walletIds: string[] }>();
function scenario(world: WorldData) {
  let value = scenarios.get(world);
  if (!value) {
    value = { sent: [], walletIds: [] };
    scenarios.set(world, value);
  }
  return value;
}

// Transporte de teste: registra os envios sem falar com o SQS. O envio real é coberto em test/concurrency/three-processes.test.ts.
class RecordingTransport implements OutboxTransport {
  constructor(private readonly sent: string[]) {}
  async publish(
    messages: readonly OutboxTransportMessage[],
  ): Promise<readonly OutboxTransportFailure[]> {
    this.sent.push(...messages.map((message) => message.id));
    return [];
  }
}

function publisher(world: WorldData, sent: string[]): OutboxPublisher {
  assertReady(world);
  return new OutboxPublisher({
    store: new MikroOrmOutboxStore(world.database.orm),
    transport: new RecordingTransport(sent),
    clock: () => new Date(),
    newLeaseToken: randomUUID,
    leaseDurationMs: 30_000,
    batchSize: 50,
  });
}

Given<WorldData>('existem eventos pendentes na mesma outbox', async function () {
  assertReady(this);
  const playerId = `player-${randomUUID()}`;
  const wallet = await this.openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  this.playerId = playerId;
  this.walletId = wallet.walletId;
  await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      this.processWager.execute(
        command(this, 'BET', '1.00', { externalTransactionId: `outbox-${index}-${randomUUID()}` }),
      ),
    ),
  );
});

When<WorldData>('dois publishers trabalham simultaneamente', async function () {
  const first: string[] = [];
  const second: string[] = [];
  await Promise.all([publisher(this, first).publishOnce(), publisher(this, second).publishOnce()]);
  scenario(this).sent.push(...first, ...second);
});

Then<WorldData>('cada evento é enviado uma vez e nenhum evento é perdido', async function () {
  assertReady(this);
  const sent = scenario(this).sent;
  const rows: unknown = await this.database.orm.em
    .getConnection()
    .execute('SELECT id FROM outbox_messages');
  assert.ok(Array.isArray(rows));
  const published: string[] = [];
  for (const row of rows) {
    assert.ok(typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string');
    published.push(row.id);
  }
  assert.equal(new Set(sent).size, sent.length);
  assert.ok(sent.length > 0);
  assert.deepEqual([...sent].sort(), [...published].sort());
});

Given<WorldData>('existem operações financeiras confirmadas no banco', async function () {
  assertReady(this);
  const playerId = `player-${randomUUID()}`;
  const wallet = await this.openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  this.playerId = playerId;
  this.walletId = wallet.walletId;
  assertWallet(this);
  scenario(this).walletIds = [this.walletId];
  await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      this.processWager.execute(
        command(this, 'BET', '10.00', {
          externalTransactionId: `restart-${index}-${randomUUID()}`,
        }),
      ),
    ),
  );
});

When<WorldData>('um publicador novo processa as operações pendentes', async function () {
  await publisher(this, scenario(this).sent).publishOnce();
});

Then<WorldData>('o saldo final de cada wallet coincide com o ledger', async function () {
  assertReady(this);
  assert.ok(scenario(this).sent.length > 0);
  for (const walletId of scenario(this).walletIds) {
    const rows: unknown = await this.database.orm.em.getConnection().execute(
      `SELECT w.balance::text AS balance,
              COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS ledger
         FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    assert.ok(Array.isArray(rows));
    const row = rows[0];
    assert.ok(
      typeof row === 'object' &&
        row !== null &&
        'balance' in row &&
        typeof row.balance === 'string' &&
        'ledger' in row &&
        typeof row.ledger === 'string',
    );
    assert.equal(row.balance, row.ledger);
    assert.equal(await currentBalance(this), '70.00');
  }
});

When<WorldData>(
  'envio apostas concorrentes por três casos de uso no mesmo processo',
  async function () {
    assertReady(this);
    assertWallet(this);
    const processes = Array.from(
      { length: 3 },
      () =>
        new ProcessWagerTransaction({
          unitOfWork: new MikroOrmFinancialUnitOfWork(this.database.orm),
          clock: () => new Date('2026-07-29T15:00:00.000Z'),
          newId: randomUUID,
        }),
    );
    const outcomes = await Promise.all(
      processes.map((process, index) =>
        process.execute(
          command(this, 'BET', '10.00', {
            externalTransactionId: `process-${index}-${randomUUID()}`,
          }),
        ),
      ),
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.transaction.status === 'PROCESSED').length,
      3,
    );
  },
);

Then<WorldData>(
  'cada aposta processada aparece uma vez no ledger e o saldo é consistente',
  async function () {
    assertReady(this);
    assertWallet(this);
    const rows: unknown = await this.database.orm.em.getConnection().execute(
      `SELECT COUNT(*)::int AS count, COUNT(DISTINCT transaction_id)::int AS unique_count
       FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
      [this.walletId],
    );
    assert.ok(Array.isArray(rows));
    const row = rows[0];
    assert.ok(
      typeof row === 'object' &&
        row !== null &&
        'count' in row &&
        typeof row.count === 'number' &&
        'unique_count' in row &&
        typeof row.unique_count === 'number',
    );
    assert.equal(row.count, 3);
    assert.equal(row.unique_count, 3);
    assert.equal(await currentBalance(this), '70.00');
    const consistency: unknown = await this.database.orm.em.getConnection().execute(
      `SELECT w.balance = COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS matches
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.id`,
      [this.walletId],
    );
    assert.ok(Array.isArray(consistency));
    const result = consistency[0];
    assert.ok(typeof result === 'object' && result !== null && 'matches' in result);
    assert.equal(result.matches, true);
  },
);
