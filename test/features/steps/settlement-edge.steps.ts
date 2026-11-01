import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { Money } from '../../../src/shared/domain/money';
import type { ProcessWagerOutcome } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { assertReady, command, currentBalance, debitCount, type WorldData } from './finance.steps';

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
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
    assert.ok(row && typeof row === 'object');
    assert.equal('status' in row ? row.status : undefined, status);
    assert.equal('failure_code' in row ? row.failure_code : undefined, code);
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
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
    assert.ok(row && typeof row === 'object' && 'count' in row);
    assert.equal(row.count, 1);
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
    await this.processWager.execute(command(this, 'BET', '25.00'));
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
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
  assert.ok(row && typeof row === 'object' && 'direction' in row);
  assert.equal(row.direction, 'CREDIT');
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
