import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { DomainError } from '../../../src/shared/domain/domain-error';
import { Money } from '../../../src/shared/domain/money';
import { startTestApp } from '../../e2e/support/test-app';
import { assertReady, command, currentBalance, type WorldData } from './finance.steps';

import { state } from './state';

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
