import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { DomainError } from '../../../src/shared/domain/domain-error';
import { Money } from '../../../src/shared/domain/money';
import { assertReady, command, currentBalance, type WorldData } from './finance.steps';

import { state } from './state';
async function wallet(w: WorldData, amount: string): Promise<void> {
  assertReady(w);
  w.playerId = `p-${randomUUID()}`;
  const x = await w.openWallet.execute({
    playerId: w.playerId,
    initialBalance: Money.from({ amount, currency: 'BRL' }),
  });
  w.walletId = x.walletId;
}
function tx(
  w: WorldData,
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK' | 'OPENING',
  amount: string,
  reference?: string,
) {
  return command(w, kind, amount, { referenceExternalTransactionId: reference });
}
async function process(
  w: WorldData,
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
  amount: string,
  reference?: string,
) {
  assertReady(w);
  return w.processWager.execute(tx(w, kind, amount, reference));
}
Given<WorldData>(
  'uma aposta de {string} rejeitada em uma wallet com saldo {string}',
  async function (a, b) {
    await wallet(this, b);
    const bet = await process(this, 'BET', a);
    state(this).betId = bet.transaction.externalTransactionId;
  },
);
When<WorldData>('processo um REFUND de {string} para essa aposta', async function (a) {
  state(this).outcome = await process(this, 'REFUND', a, state(this).betId);
});
Given<WorldData>(
  'uma aposta de {string} já processada em outra wallet ou rodada',
  async function (a) {
    await wallet(this, '75.00');
    const bet = await process(this, 'BET', a);
    state(this).betId = bet.transaction.externalTransactionId;
    await wallet(this, '10.00');
    state(this).savedBalance = '10.00';
  },
);
Then<WorldData>(
  'a transação fica {string} com {string} e o saldo não muda',
  async function (status, code) {
    assertReady(this);
    assert.equal(state(this).outcome?.transaction.status, status);
    assert.equal(state(this).outcome?.transaction.failureCode, code);
    assert.equal(await currentBalance(this), state(this).savedBalance ?? this.balance);
  },
);
Given<WorldData>(
  'uma aposta de {string} com LOSS já processado em uma wallet com saldo {string}',
  async function (a, b) {
    await wallet(this, b);
    const bet = await process(this, 'BET', a);
    state(this).betId = bet.transaction.externalTransactionId;
    const loss = await process(this, 'LOSS', a, state(this).betId);
    state(this).betId = loss.transaction.externalTransactionId;
  },
);
When<WorldData>('processo um ROLLBACK do LOSS', async function () {
  state(this).outcome = await process(this, 'ROLLBACK', '25.00', state(this).betId);
});
When<WorldData>(
  'processo um ROLLBACK de {string} para uma referência inexistente por seis buscas',
  async function (a) {
    assertReady(this);
    const id = `missing-${randomUUID()}`;
    state(this).refId = id;
    state(this).outcome = await process(this, 'ROLLBACK', a, id);
    const outcome = state(this).outcome;
    assert.ok(outcome);
    for (let i = 0; i < 6; i++) {
      await this.database.orm.em
        .getConnection()
        .execute('UPDATE wager_transactions SET reference_next_attempt_at = ? WHERE id = ?', [
          new Date('2020-01-01T00:00:00Z'),
          outcome.transaction.id,
        ]);
      await this.processPending?.runOnce();
    }
    const rows = await this.database.orm.em
      .getConnection()
      .execute('SELECT status FROM wager_transactions WHERE id=?', [outcome.transaction.id]);
    assert.equal(rows[0]?.status, 'REJECTED');
  },
);
Given<WorldData>(
  'uma wallet com saldo {string} e um ROLLBACK de {string} rejeitado por referência não encontrada',
  async function (b, a) {
    await wallet(this, b);
    const id = `missing-${randomUUID()}`;
    state(this).refId = id;
    state(this).outcome = await process(this, 'ROLLBACK', a, id);
    assertReady(this);
    const outcome = state(this).outcome;
    assert.ok(outcome);
    for (let i = 0; i < 6; i++) {
      await this.database.orm.em
        .getConnection()
        .execute('UPDATE wager_transactions SET reference_next_attempt_at = ? WHERE id = ?', [
          new Date('2020-01-01T00:00:00Z'),
          outcome.transaction.id,
        ]);
      await this.processPending?.runOnce();
    }
  },
);
When<WorldData>('processo o BET de {string} que corresponde à referência', async function (a) {
  const bet = command(this, 'BET', a, {
    externalTransactionId: state(this).refId,
    idempotencyKey: `provider-a:${state(this).refId}`,
  });
  assertReady(this);
  await this.processWager.execute(bet);
});
Then<WorldData>(
  'o ROLLBACK continua {string} e o saldo reflete apenas o BET',
  async function (status) {
    assertReady(this);
    const rows = await this.database.orm.em
      .getConnection()
      .execute('SELECT status FROM wager_transactions WHERE external_transaction_id=?', [
        state(this).outcome?.transaction.externalTransactionId,
      ]);
    assert.equal(rows[0]?.status, status);
    assert.equal(await currentBalance(this), '75.00');
  },
);
Given<WorldData>(
  'uma wallet com saldo {string} e um BET sem vínculo de resultado',
  async function (a) {
    await wallet(this, a);
    const bet = await process(this, 'BET', '25.00');
    state(this).betId = bet.transaction.externalTransactionId;
  },
);
When<WorldData>('processo dois WIN de {string} sem referência para esse BET', async function (a) {
  state(this).errors = [];
  const x = await process(this, 'WIN', a);
  const y = await process(this, 'WIN', a);
  state(this).outcome = x;
  state(this).rollback = y;
});
Then<WorldData>('os dois WIN são processados e o saldo é {string}', async function (a) {
  assertReady(this);
  assert.equal(state(this).outcome?.transaction.status, 'PROCESSED');
  assert.equal(state(this).rollback?.transaction.status, 'PROCESSED');
  assert.equal(await currentBalance(this), a);
});
When<WorldData>(
  'envio uma operação OPENING de {string} como transação externa',
  async function (a) {
    assertReady(this);
    state(this).errors = [];
    try {
      await this.processWager.execute(tx(this, 'OPENING', a));
    } catch (error: unknown) {
      state(this).errors?.push(error);
    }
  },
);
Then<WorldData>(
  'a operação é recusada com {string} e o saldo permanece {string}',
  async function (code, a) {
    assertReady(this);
    const error = state(this).errors?.[0];
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    assert.equal(await currentBalance(this), a);
  },
);
