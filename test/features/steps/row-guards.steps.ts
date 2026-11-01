import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { Money } from '../../../src/shared/domain/money';
import { WalletQueries } from '../../../src/modules/wallet/application/wallet-queries';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import {
  assertReady,
  assertWallet,
  command,
  currentBalance,
  type WorldData,
} from './finance.steps';

import { state } from './state';

async function openWallet(world: WorldData, amount: string): Promise<void> {
  assertReady(world);
  world.playerId = `player-${randomUUID()}`;
  const opened = await world.openWallet.execute({
    playerId: world.playerId,
    initialBalance: Money.from({ amount, currency: 'BRL' }),
  });
  world.walletId = opened.walletId;
  world.balance = amount;
}

Given<WorldData>(
  'uma wallet com saldo {string} e um lançamento no ledger',
  async function (amount) {
    assertReady(this);
    await openWallet(this, amount);
  },
);

When<WorldData>('tento atualizar, excluir e truncar os lançamentos diretamente', async function () {
  assertReady(this);
  assertWallet(this);
  state(this).errors = [];
  const connection = this.database.orm.em.getConnection();
  for (const statement of [
    'UPDATE wallet_ledger_entries SET amount = amount WHERE wallet_id = ?',
    'DELETE FROM wallet_ledger_entries WHERE wallet_id = ?',
    'TRUNCATE wallet_ledger_entries',
  ]) {
    try {
      await connection.execute(statement, statement.includes('?') ? [this.walletId] : []);
    } catch (error: unknown) {
      state(this).errors?.push(error);
    }
  }
});

Then<WorldData>(
  'todas as operações são recusadas e o saldo permanece {string}',
  async function (amount) {
    assertReady(this);
    assert.equal(state(this).errors?.length, 3);
    assert.equal(await currentBalance(this), amount);
  },
);

When<WorldData>(
  'tento inserir diretamente um lançamento com aritmética inconsistente',
  async function () {
    assertReady(this);
    assertWallet(this);
    const rejected = await this.processWager.execute(command(this, 'BET', '25.00'));
    state(this).errors = [];
    try {
      await this.database.orm.em
        .getConnection()
        .execute(
          'INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            randomUUID(),
            this.walletId,
            rejected.transaction.id,
            'DEBIT',
            'BRL',
            '1.00',
            '10.00',
            '10.00',
            new Date(),
          ],
        );
    } catch (error: unknown) {
      state(this).errors?.push(error);
    }
  },
);

Given<WorldData>(
  'uma wallet com saldo {string} e uma transação com lançamento no ledger',
  async function (amount) {
    assertReady(this);
    await openWallet(this, amount);
  },
);

When<WorldData>(
  'tento inserir outro lançamento para a mesma transação e wallet',
  async function () {
    assertReady(this);
    assertWallet(this);
    const rows = await this.database.orm.em
      .getConnection()
      .execute(
        "SELECT id FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING' ORDER BY created_at LIMIT 1",
        [this.walletId],
      );
    const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
    const transactionId =
      first && typeof first === 'object' && 'id' in first && typeof first.id === 'string'
        ? first.id
        : undefined;
    assert.ok(typeof transactionId === 'string');
    state(this).errors = [];
    try {
      await this.database.orm.em
        .getConnection()
        .execute(
          'INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            randomUUID(),
            this.walletId,
            transactionId,
            'CREDIT',
            'BRL',
            '1.00',
            '0.00',
            '1.00',
            new Date(),
          ],
        );
    } catch (error: unknown) {
      state(this).errors?.push(error);
    }
  },
);

Then<WorldData>(
  'o banco recusa o lançamento duplicado e o saldo permanece {string}',
  async function (amount) {
    assertReady(this);
    assert.equal(state(this).errors?.length, 1);
    assert.equal(await currentBalance(this), amount);
  },
);

When<WorldData>('altero diretamente o saldo sem inserir lançamento', async function () {
  assertReady(this);
  assertWallet(this);
  state(this).errors = [];
  try {
    await this.database.orm.em
      .getConnection()
      .execute('UPDATE wallets SET balance = balance + 1, version = version + 1 WHERE id = ?', [
        this.walletId,
      ]);
  } catch (error: unknown) {
    state(this).errors?.push(error);
  }
});

Then<WorldData>(
  'a escrita é recusada pelo trigger de saldo e o saldo permanece {string}',
  async function (amount) {
    assertReady(this);
    const error = state(this).errors?.[0];
    assert.ok(error && typeof error === 'object');
    assert.ok('code' in error && error.code === '23514');
    assert.ok('message' in error && error.message === 'wallet balance does not match its ledger');
    assert.equal(state(this).errors?.length, 1);
    assert.equal(await currentBalance(this), amount);
  },
);

Given<WorldData>('uma wallet com saldo {string} e lançamentos no ledger', async function (amount) {
  assertReady(this);
  await openWallet(this, amount);
});

When<WorldData>(
  'tento inserir um lançamento com saldo inicial diferente do saldo final anterior',
  async function () {
    assertReady(this);
    assertWallet(this);
    const rejected = await this.processWager.execute(command(this, 'BET', '25.00'));
    state(this).errors = [];
    try {
      await this.database.orm.em
        .getConnection()
        .execute(
          'INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            randomUUID(),
            this.walletId,
            rejected.transaction.id,
            'DEBIT',
            'BRL',
            '1.00',
            '8.00',
            '7.00',
            new Date(),
          ],
        );
    } catch (error: unknown) {
      state(this).errors?.push(error);
    }
  },
);

Then<WorldData>(
  'o lançamento é recusado pelo trigger de saldo e o saldo permanece {string}',
  async function (amount) {
    assertReady(this);
    assertWallet(this);
    const error = state(this).errors?.[0];
    assert.ok(error && typeof error === 'object');
    assert.ok('code' in error && error.code === '23514');
    assert.ok('message' in error && error.message === 'wallet balance does not match its ledger');
    assert.equal(state(this).errors?.length, 1);
    assert.equal(await currentBalance(this), amount);
  },
);

When<WorldData>('concluo o cenário sem alterar a wallet', async function () {
  assertReady(this);
  assertWallet(this);
  const queries = new WalletQueries({
    unitOfWork: new MikroOrmFinancialUnitOfWork(this.database.orm),
    clock: () => new Date(),
    newId: randomUUID,
  });
  state(this).report = await queries.reconcile(this.walletId);
});

Then<WorldData>('o invariante entre saldo e ledger permanece válido', async function () {
  const report = state(this).report;
  assert.ok(report);
  assert.equal(report.consistent, true);
});

Given<WorldData>('uma wallet com saldo {string} e sua versão inicial', async function (amount) {
  await openWallet(this, amount);
  assertReady(this);
  assertWallet(this);
  const rows = await this.database.orm.em
    .getConnection()
    .execute('SELECT version FROM wallets WHERE id = ?', [this.walletId]);
  const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
  const version =
    first && typeof first === 'object' && 'version' in first && typeof first.version === 'number'
      ? first.version
      : undefined;
  assert.ok(typeof version === 'number');
  state(this).version = version;
});

When<WorldData>('processo dois débitos sucessivos de {string}', async function (amount) {
  assertReady(this);
  await this.processWager.execute(command(this, 'BET', amount));
  await this.processWager.execute(command(this, 'BET', amount));
});

Then<WorldData>('a versão aumenta em dois e o saldo é {string}', async function (amount) {
  assertReady(this);
  assertWallet(this);
  const rows = await this.database.orm.em
    .getConnection()
    .execute('SELECT version FROM wallets WHERE id = ?', [this.walletId]);
  const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
  const version =
    first && typeof first === 'object' && 'version' in first ? first.version : undefined;
  assert.equal(version, (state(this).version ?? 0) + 2);
  assert.equal(await currentBalance(this), amount);
});

Given<WorldData>('uma wallet com divergência entre saldo e ledger', async function () {
  assertReady(this);
  await openWallet(this, '100.00');
  await this.database.orm.em.fork().transactional(async (em) => {
    await em.execute("SET LOCAL session_replication_role = 'replica'");
    await em.execute(
      'UPDATE wallets SET balance = balance + 1, version = version + 1 WHERE id = ?',
      [this.walletId],
    );
  });
});

When<WorldData>('reconcilio a wallet', async function () {
  assertReady(this);
  assertWallet(this);
  const queries = new WalletQueries({
    unitOfWork: new MikroOrmFinancialUnitOfWork(this.database.orm),
    clock: () => new Date(),
    newId: randomUUID,
  });
  state(this).report = await queries.reconcile(this.walletId);
});

Then<WorldData>('a divergência é reportada e contada sem correção automática', async function () {
  assertReady(this);
  assertWallet(this);
  const walletId = this.walletId;
  const report = state(this).report;
  assert.ok(report);
  assert.equal(report.consistent, false);
  assert.equal(report.difference.toString(), '1.00');
  assert.equal(await currentBalance(this), '101.00');
  await this.database.orm.em.fork().transactional(async (em) => {
    await em.execute("SET LOCAL session_replication_role = 'replica'");
    await em.execute(
      'UPDATE wallets SET balance = balance - 1, version = version + 1 WHERE id = ?',
      [walletId],
    );
  });
});

Given<WorldData>('uma wallet com saldo {string} e um débito em andamento', async function (amount) {
  await openWallet(this, amount);
});

When<WorldData>('reconcilio a wallet enquanto o débito é confirmado', async function () {
  assertReady(this);
  assertWallet(this);
  const queries = new WalletQueries({
    unitOfWork: new MikroOrmFinancialUnitOfWork(this.database.orm),
    clock: () => new Date(),
    newId: randomUUID,
  });
  const [, report] = await Promise.all([
    this.processWager.execute(command(this, 'BET', '10.00')),
    queries.reconcile(this.walletId),
  ]);
  state(this).report = report;
});

Then<WorldData>(
  'a reconciliação não reporta divergência e o saldo é {string}',
  async function (amount) {
    const report = state(this).report;
    assert.ok(report);
    assert.equal(report.consistent, true);
    assert.equal(await currentBalance(this), amount);
  },
);
