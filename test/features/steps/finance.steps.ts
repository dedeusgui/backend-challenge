import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { After, Before, Given, Then, When, setWorldConstructor } from '@cucumber/cucumber';
import { World, type IWorld } from '@cucumber/cucumber';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { Money } from '../../../src/shared/domain/money';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { ProcessPendingReferences } from '../../../src/modules/wagering/application/process-pending-references.use-case';
import { DomainError } from '../../../src/shared/domain/domain-error';
import { createTestDatabase, type TestDatabase } from '../../integration/support/test-database';

const NOW = new Date('2026-07-29T15:00:00.000Z');
export interface WorldData extends IWorld<unknown> {
  database?: TestDatabase;
  openWallet?: OpenWallet;
  processWager?: ProcessWagerTransaction;
  processPending?: ProcessPendingReferences;
  pendingResolved?: boolean;
  parallelWalletBalances?: string[];
  walletId?: string;
  playerId?: string;
  balance?: string;
  last?: Awaited<ReturnType<ProcessWagerTransaction['execute']>>;
  refusal?: unknown;
}
class FinancialWorld extends World<unknown> implements WorldData {
  database?: TestDatabase;
  openWallet?: OpenWallet;
  processWager?: ProcessWagerTransaction;
  processPending?: ProcessPendingReferences;
  walletId?: string;
  playerId?: string;
  balance?: string;
  last?: Awaited<ReturnType<ProcessWagerTransaction['execute']>>;
  pendingResolved?: boolean;
  parallelWalletBalances?: string[];
  refusal?: unknown;
}
setWorldConstructor(FinancialWorld);

export function assertReady(
  world: WorldData,
): asserts world is WorldData &
  Required<Pick<WorldData, 'database' | 'openWallet' | 'processWager'>> {
  assert.ok(world.database && world.openWallet && world.processWager);
}
export function assertWallet(
  world: WorldData,
): asserts world is WorldData & Required<Pick<WorldData, 'walletId' | 'playerId'>> {
  assert.ok(world.walletId && world.playerId);
}

Before<WorldData>(async function () {
  this.database = await createTestDatabase();
  const unitOfWork = new MikroOrmFinancialUnitOfWork(this.database.orm);
  const dependencies = { unitOfWork, clock: () => NOW, newId: randomUUID };
  this.openWallet = new OpenWallet(dependencies);
  this.processWager = new ProcessWagerTransaction(dependencies);
  this.processPending = new ProcessPendingReferences(dependencies);
});
After<WorldData>(async function () {
  await this.database?.drop();
});
Given<WorldData>('uma wallet com saldo {string}', async function (amount) {
  assertReady(this);
  this.playerId = `player-${randomUUID()}`;
  const result = await this.openWallet.execute({
    playerId: this.playerId,
    initialBalance: Money.from({ amount, currency: 'BRL' }),
  });
  this.walletId = result.walletId;
  this.balance = amount;
});

export function command(
  world: WorldData,
  kind: ProcessWagerCommand['kind'],
  amount: string,
  overrides: Partial<ProcessWagerCommand> = {},
): ProcessWagerCommand {
  assertReady(world);
  assertWallet(world);
  const id = `tx-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${id}`,
    providerId: 'provider-a',
    externalTransactionId: id,
    playerId: world.playerId,
    walletId: world.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: Money.from({ amount, currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    correlationId: randomUUID(),
    ...overrides,
  };
}
export async function currentBalance(world: WorldData): Promise<string> {
  assertReady(world);
  assertWallet(world);
  const rows = await world.database.orm.em
    .getConnection()
    .execute('SELECT balance::text AS balance FROM wallets WHERE id = ?', [world.walletId]);
  const first = rows[0];
  assert.ok(first && typeof first.balance === 'string');
  return first.balance;
}
export async function debitCount(world: WorldData): Promise<number> {
  assertReady(world);
  assertWallet(world);
  const rows = await world.database.orm.em
    .getConnection()
    .execute(
      "SELECT COUNT(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [world.walletId],
    );
  const first = rows[0];
  assert.ok(first && typeof first.count === 'number');
  return first.count;
}
When<WorldData>('processo uma aposta de {string}', async function (amount) {
  assertReady(this);
  this.last = await this.processWager.execute(command(this, 'BET', amount));
});
When<WorldData>('tento processar uma aposta de {string}', async function (amount) {
  assertReady(this);
  this.refusal = await this.processWager.execute(command(this, 'BET', amount)).then(
    () => undefined,
    (error: unknown) => error,
  );
});
When<WorldData>('processo uma aposta de moeda {string}', async function (currency) {
  assertReady(this);
  this.last = await this.processWager.execute(
    command(this, 'BET', '1.00', { money: Money.from({ amount: '1.00', currency }) }),
  );
});
When<WorldData>('processo duas vezes a mesma aposta de {string}', async function (amount) {
  assertReady(this);
  const request = command(this, 'BET', amount);
  this.last = await this.processWager.execute(request);
  const replay = await this.processWager.execute(request);
  assert.equal(replay.idempotentReplay, true);
});
When<WorldData>(
  'envio cinquenta vezes a mesma aposta de {string} em paralelo',
  async function (amount) {
    assertReady(this);
    const request = command(this, 'BET', amount);
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => this.processWager.execute(request)),
    );
    assert.equal(outcomes.filter((outcome) => !outcome.idempotentReplay).length, 1);
  },
);
When<WorldData>('envio duas apostas de {string} em paralelo', async function (amount) {
  assertReady(this);
  const outcomes = await Promise.all([
    this.processWager.execute(command(this, 'BET', amount)),
    this.processWager.execute(command(this, 'BET', amount)),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.transaction.status === 'PROCESSED').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.transaction.status === 'REJECTED').length, 1);
});
When<WorldData>('envio uma aposta em cada uma de duas wallets em paralelo', async function () {
  assertReady(this);
  assertWallet(this);
  const playerId = `player-${randomUUID()}`;
  const wallet = await this.openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  const outcomes = await Promise.all([
    this.processWager.execute(command(this, 'BET', '25.00')),
    this.processWager.execute(
      command(this, 'BET', '25.00', { playerId, walletId: wallet.walletId }),
    ),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.transaction.status === 'PROCESSED').length, 2);
  const rows = await this.database.orm.em
    .getConnection()
    .execute('SELECT balance::text AS balance FROM wallets WHERE id IN (?, ?)', [
      this.walletId,
      wallet.walletId,
    ]);
  this.parallelWalletBalances = rows
    .map((row) => {
      assert.ok(typeof row.balance === 'string');
      return row.balance;
    })
    .sort();
});
When<WorldData>(
  'processo uma aposta de {string}, uma perda e o rollback da aposta',
  async function (amount) {
    assertReady(this);
    const bet = command(this, 'BET', amount);
    await this.processWager.execute(bet);
    await this.processWager.execute(
      command(this, 'LOSS', amount, { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    this.last = await this.processWager.execute(
      command(this, 'ROLLBACK', amount, {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
  },
);
When<WorldData>('envio um refund sem referência e depois a aposta referenciada', async function () {
  assertReady(this);
  // The held command is created against a future external transaction identity.
  const referenceId = `future-${randomUUID()}`;
  const pending = command(this, 'REFUND', '10.00', { referenceExternalTransactionId: referenceId });
  this.last = await this.processWager.execute(pending);
  assert.equal(this.last.transaction.status, 'PENDING_REFERENCE');
  const bet = command(this, 'BET', '10.00', {
    externalTransactionId: referenceId,
    idempotencyKey: `provider-a:${referenceId}`,
  });
  await this.processWager.execute(bet);
  assertReady(this);
  await this.database.orm.em
    .getConnection()
    .execute('UPDATE wager_transactions SET reference_next_attempt_at = ? WHERE id = ?', [
      new Date('2026-07-29T14:00:00.000Z'),
      this.last.transaction.id,
    ]);
  await this.processPending?.runOnce();
  const rows = await this.database.orm.em
    .getConnection()
    .execute('SELECT status FROM wager_transactions WHERE id = ?', [this.last.transaction.id]);
  const row = rows[0];
  assert.ok(row && typeof row.status === 'string');
  this.pendingResolved = row.status === 'PROCESSED';
});
Then<WorldData>(
  'a transação fica {string} e o saldo permanece {string}',
  async function (status, amount) {
    assertReady(this);
    assert.equal(this.last?.transaction.status, status);
    assert.equal(await currentBalance(this), amount);
  },
);
Then<WorldData>('ocorre apenas um débito e o saldo é {string}', async function (amount) {
  assertReady(this);
  assert.equal(await debitCount(this), 1);
  assert.equal(await currentBalance(this), amount);
});
Then<WorldData>(
  'uma transação é processada, uma é rejeitada e o saldo é {string}',
  async function (amount) {
    assertReady(this);
    assert.equal(await debitCount(this), 1);
    assert.equal(await currentBalance(this), amount);
  },
);
Then<WorldData>(
  'o domínio recusa a aposta com {string} e o saldo permanece {string}',
  async function (code, amount) {
    assertReady(this);
    assert.ok(this.refusal instanceof DomainError, 'a aposta deveria ser recusada pelo domínio');
    assert.equal(this.refusal.code, code);
    assert.equal(await currentBalance(this), amount);
  },
);
Then<WorldData>('o saldo é {string}', async function (amount) {
  assertReady(this);
  assert.equal(await currentBalance(this), amount);
});
Then<WorldData>('as duas wallets ficam com saldo {string}', async function (amount) {
  assert.deepEqual(this.parallelWalletBalances, [amount, amount]);
});
Then<WorldData>('o refund pendente é processado e o saldo é {string}', async function (amount) {
  assertReady(this);
  assert.equal(this.pendingResolved, true);
  assert.equal(await currentBalance(this), amount);
});
