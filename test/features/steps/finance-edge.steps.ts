import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { DomainError } from '../../../src/shared/domain/domain-error';
import { Money } from '../../../src/shared/domain/money';
import type { ProcessWagerOutcome } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WalletQueries } from '../../../src/modules/wallet/application/wallet-queries';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { startTestApp } from '../../e2e/support/test-app';
import {
  assertReady,
  assertWallet,
  command,
  currentBalance,
  debitCount,
  type WorldData,
} from './finance.steps';

import { state } from './state';

async function createBet(world: WorldData, amount: string): Promise<string> {
  assertReady(world);
  const bet = command(world, 'BET', amount);
  await world.processWager.execute(bet);
  state(world).betId = bet.externalTransactionId;
  return bet.externalTransactionId;
}

async function processResult(
  world: WorldData,
  kind: 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
  amount: string,
  referenceId: string,
): Promise<ProcessWagerOutcome> {
  assertReady(world);
  const outcome = await world.processWager.execute(
    command(world, kind, amount, { referenceExternalTransactionId: referenceId }),
  );
  return outcome;
}

Given<WorldData>(
  'os valores monetários inválidos {string}, {string}, {string}, {string} e {string}',
  function (one, two, three, four, five) {
    state(this).invalidAmounts = [one, two, three, four, five];
  },
);
When<WorldData>('tento construir Money com cada valor', function () {
  const amounts = state(this).invalidAmounts;
  assert.ok(amounts);
  state(this).moneyFailures = amounts.map((amount) => {
    try {
      Money.from({ amount, currency: 'BRL' });
      return undefined;
    } catch (error: unknown) {
      return error;
    }
  });
});
Then<WorldData>('cada construção falha com erro de domínio', function () {
  const failures = state(this).moneyFailures;
  assert.ok(failures);
  assert.equal(failures.length, 5);
  for (const failure of failures) {
    assert.ok(failure instanceof DomainError);
    assert.equal(failure.code, 'INVALID_MONEY');
  }
});

When<WorldData>('envio pela API uma aposta com valor malformado {string}', async function (amount) {
  assertReady(this);
  const api = await startTestApp(this.database.url);
  state(this).api = api;
  const client = await api.createApiClient({
    name: `edge-${randomUUID()}`,
    role: 'PROVIDER',
    providerId: 'provider-a',
  });
  const response = await fetch(`${api.baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${client.apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': `provider-a:${randomUUID()}`,
    },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId: this.playerId,
      walletId: this.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    }),
  });
  state(this).apiStatus = response.status;
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null && 'error' in body);
  const error = body.error;
  assert.ok(typeof error === 'object' && error !== null && 'code' in error);
  assert.ok(typeof error.code === 'string');
  state(this).apiCode = error.code;
});
Then<WorldData>('a resposta da API é {int} com o código de erro de dinheiro', function (status) {
  assert.equal(state(this).apiStatus, status);
  assert.equal(state(this).apiCode, 'INVALID_MONEY');
  const api = state(this).api;
  assert.ok(api);
  return api.close();
});

Given<WorldData>(/uma wallet com saldo próximo ao limite NUMERIC\(20,2\)/, async function () {
  assertReady(this);
  this.playerId = `player-${randomUUID()}`;
  const opened = await this.openWallet.execute({
    playerId: this.playerId,
    initialBalance: Money.from({ amount: '999999999999999999.99', currency: 'BRL' }),
  });
  this.walletId = opened.walletId;
  this.balance = '999999999999999999.99';
});
When<WorldData>('processo um crédito que excede o limite do saldo', async function () {
  assertReady(this);
  this.last = await this.processWager.execute(command(this, 'WIN', '0.01'));
});
Then<WorldData>(
  'a transação fica {string} com {string} e o saldo não sofre overflow',
  async function (status, code) {
    assertReady(this);
    assert.equal(this.last?.transaction.status, status);
    assert.equal(this.last?.transaction.failureCode, code);
    assert.equal(await currentBalance(this), '999999999999999999.99');
  },
);

When<WorldData>(
  'tento inserir um lançamento de {string} em moeda {string} para a wallet BRL',
  async function (amount, currency) {
    assertReady(this);
    const rejected = await this.processWager.execute(command(this, 'BET', '25.00'));
    try {
      await this.database.orm.em
        .getConnection()
        .execute(
          'INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            randomUUID(),
            this.walletId,
            rejected.transaction.id,
            'CREDIT',
            currency,
            amount,
            '10.00',
            '11.00',
            new Date('2026-07-29T15:00:00.000Z'),
          ],
        );
    } catch (error: unknown) {
      assert.ok(error instanceof Error);
      state(this).dbRejected = true;
      return;
    }
    state(this).dbRejected = false;
  },
);
Then<WorldData>(
  'o banco recusa o lançamento e o saldo permanece {string}',
  async function (amount) {
    assertReady(this);
    assert.ok(state(this).dbRejected === true || state(this).errors?.length === 1);
    assert.equal(await currentBalance(this), amount);
  },
);

Given<WorldData>(
  'uma aposta de {string} já processada em uma wallet com saldo {string}',
  async function (amount, balance) {
    await openWallet(this, balance);
    state(this).betId = await createBet(this, amount);
  },
);
When<WorldData>('envio dois rollbacks dessa aposta em paralelo', async function () {
  assertReady(this);
  const betId = state(this).betId;
  assert.ok(betId);
  const outcomes = await Promise.all([
    processResult(this, 'ROLLBACK', '25.00', betId),
    processResult(this, 'ROLLBACK', '25.00', betId),
  ]);
  state(this).outcomes = outcomes;
});
Then<WorldData>('ocorre apenas um estorno e o saldo é {string}', async function (amount) {
  assertReady(this);
  const outcomes = state(this).outcomes;
  assert.ok(outcomes);
  assert.equal(outcomes.filter((outcome) => outcome.transaction.status === 'PROCESSED').length, 1);
  assert.equal(await currentBalance(this), amount);
});
When<WorldData>('envio WIN, REFUND e LOSS para essa aposta em paralelo', async function () {
  assertReady(this);
  const betId = state(this).betId;
  assert.ok(betId);
  state(this).outcomes = await Promise.all([
    processResult(this, 'WIN', '25.00', betId),
    processResult(this, 'REFUND', '25.00', betId),
    processResult(this, 'LOSS', '25.00', betId),
  ]);
});
Then<WorldData>(
  'apenas um resultado é processado e o saldo reflete um único resultado',
  async function () {
    assertReady(this);
    const outcomes = state(this).outcomes;
    assert.ok(outcomes);
    assert.equal(
      outcomes.filter((outcome) => outcome.transaction.status === 'PROCESSED').length,
      1,
    );
    assert.equal(outcomes.filter((outcome) => outcome.transaction.status === 'REJECTED').length, 2);
    const balance = await currentBalance(this);
    assert.ok(['75.00', '100.00'].includes(balance));
    assert.equal(await debitCount(this), 1);
  },
);

Given<WorldData>(
  'uma aposta de {string} com WIN já processado em uma wallet com saldo {string}',
  async function (amount, balance) {
    await openWallet(this, balance);
    const betId = await createBet(this, amount);
    await processResult(this, 'WIN', amount, betId);
    state(this).betId = betId;
  },
);
When<WorldData>('processo um REFUND para essa aposta', async function () {
  const betId = state(this).betId;
  assert.ok(betId);
  state(this).outcome = await processResult(this, 'REFUND', '25.00', betId);
});
Then<WorldData>(
  'a transação fica {string} com {string} e o saldo permanece {string}',
  async function (status, code, amount) {
    assertReady(this);
    const transactionId = state(this).outcome?.transaction.id;
    assert.ok(transactionId);
    const rows = await this.database.orm.em
      .getConnection()
      .execute('SELECT status, failure_code FROM wager_transactions WHERE id = ?', [transactionId]);
    assert.equal(rows[0]?.status, status);
    assert.equal(rows[0]?.failure_code, code);
    assert.equal(await currentBalance(this), amount);
  },
);
When<WorldData>('processo um ROLLBACK da aposta', async function () {
  const betId = state(this).betId;
  assert.ok(betId);
  state(this).outcome = await processResult(this, 'ROLLBACK', '25.00', betId);
});
Then<WorldData>(
  'a aposta é estornada, o WIN permanece e o saldo é {string}',
  async function (amount) {
    assertReady(this);
    assert.equal(state(this).outcome?.transaction.status, 'PROCESSED');
    assert.equal(await currentBalance(this), amount);
    const rows = await this.database.orm.em
      .getConnection()
      .execute(
        "SELECT COUNT(*)::int AS count FROM wager_transactions WHERE reference_transaction_id = (SELECT id FROM wager_transactions WHERE external_transaction_id = ?) AND kind = 'WIN' AND status = 'PROCESSED'",
        [state(this).betId],
      );
    assert.equal(rows[0]?.count, 1);
  },
);

Given<WorldData>(
  'um WIN de {string} já processado em uma wallet com saldo {string}',
  async function (amount, balance) {
    await openWallet(this, balance);
    assertReady(this);
    const win = await this.processWager.execute(command(this, 'WIN', amount));
    state(this).targetId = win.transaction.externalTransactionId;
  },
);
Given<WorldData>(
  'um WIN de {string} já processado e gasto em uma wallet com saldo {string}',
  async function (amount, balance) {
    await openWallet(this, balance);
    assertReady(this);
    const win = await this.processWager.execute(command(this, 'WIN', amount));
    state(this).targetId = win.transaction.externalTransactionId;
    await this.processWager?.execute(command(this, 'BET', '25.00'));
  },
);
When<WorldData>('processo um ROLLBACK do WIN', async function () {
  const targetId = state(this).targetId;
  assert.ok(targetId);
  state(this).outcome = await processResult(this, 'ROLLBACK', '25.00', targetId);
});
Then<WorldData>('o lançamento do WIN é debitado e o saldo é {string}', async function (amount) {
  assertReady(this);
  assert.equal(state(this).outcome?.transaction.status, 'PROCESSED');
  assert.equal(await currentBalance(this), amount);
  const rows = await this.database.orm.em
    .getConnection()
    .execute(
      'SELECT direction FROM wallet_ledger_entries WHERE transaction_id = (SELECT id FROM wager_transactions WHERE external_transaction_id = ?)',
      [state(this).targetId],
    );
  assert.equal(rows[0]?.direction, 'CREDIT');
  assert.equal(await debitCount(this), 1);
});

Given<WorldData>(
  'um REFUND de {string} já processado para uma aposta em uma wallet com saldo {string}',
  async function (amount, balance) {
    await openWallet(this, balance);
    const betId = await createBet(this, amount);
    const refund = await processResult(this, 'REFUND', amount, betId);
    state(this).betId = betId;
    state(this).targetId = refund.transaction.externalTransactionId;
  },
);
When<WorldData>('processo um ROLLBACK do REFUND e depois um ROLLBACK da aposta', async function () {
  const refundId = state(this).targetId;
  const betId = state(this).betId;
  assert.ok(refundId && betId);
  await processResult(this, 'ROLLBACK', '25.00', refundId);
  state(this).outcome = await processResult(this, 'ROLLBACK', '25.00', betId);
});
Then<WorldData>(
  'o saldo é {string} e o BET não pode ser revertido novamente',
  async function (amount) {
    assertReady(this);
    assert.equal(await currentBalance(this), amount);
    assert.equal(state(this).outcome?.transaction.status, 'REJECTED');
    assert.equal(await debitCount(this), 2);
  },
);
When<WorldData>('processo um estorno de {string} desse WIN', async function (amount) {
  const targetId = state(this).targetId;
  assert.ok(targetId);
  state(this).outcome = await processResult(this, 'ROLLBACK', amount, targetId);
});

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
    const transactionId = rows[0]?.id;
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
  await this.database.orm.em
    .getConnection()
    .execute('UPDATE wallets SET balance = balance + 1, version = version + 1 WHERE id = ?', [
      this.walletId,
    ]);
});
Then<WorldData>(
  'a escrita é aceita pelo esquema e o invariante fica divergente',
  async function () {
    assertReady(this);
    assert.equal(await currentBalance(this), '11.00');
    await this.database.orm.em
      .getConnection()
      .execute('UPDATE wallets SET balance = balance - 1, version = version + 1 WHERE id = ?', [
        this.walletId,
      ]);
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
Then<WorldData>('a reconciliação reporta a divergência do lançamento', async function () {
  assertReady(this);
  assertWallet(this);
  assert.equal(state(this).errors?.length, 0);
  const queries = new WalletQueries({
    unitOfWork: new MikroOrmFinancialUnitOfWork(this.database.orm),
    clock: () => new Date(),
    newId: randomUUID,
  });
  const report = await queries.reconcile(this.walletId);
  assert.equal(report.consistent, false);
  assert.equal(report.difference.toString(), '1.00');
  await this.database.orm.em
    .getConnection()
    .execute('UPDATE wallets SET balance = balance - 1, version = version + 1 WHERE id = ?', [
      this.walletId,
    ]);
});
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
  const row = rows[0];
  assert.ok(row && typeof row.version === 'number');
  state(this).version = row.version;
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
  assert.equal(rows[0]?.version, (state(this).version ?? 0) + 2);
  assert.equal(await currentBalance(this), amount);
});
Given<WorldData>('uma wallet com divergência entre saldo e ledger', async function () {
  assertReady(this);
  await openWallet(this, '100.00');
  await this.database.orm.em
    .getConnection()
    .execute('UPDATE wallets SET balance = balance + 1, version = version + 1 WHERE id = ?', [
      this.walletId,
    ]);
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
  const report = state(this).report;
  assert.ok(report);
  assert.equal(report.consistent, false);
  assert.equal(report.difference.toString(), '1.00');
  assert.equal(await currentBalance(this), '101.00');
  assertReady(this);
  await this.database.orm.em
    .getConnection()
    .execute('UPDATE wallets SET balance = balance - 1, version = version + 1 WHERE id = ?', [
      this.walletId,
    ]);
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
