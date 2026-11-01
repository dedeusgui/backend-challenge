import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Then, When } from '@cucumber/cucumber';
import {
  IdempotencyConflictError,
  MessagePayloadConflictError,
} from '../../../src/shared/application/application-errors';
import { hashOf } from '../../../src/modules/wagering/domain/wager-payload';
import type { ProcessWagerCommand } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import {
  assertReady,
  assertWallet,
  command,
  currentBalance,
  debitCount,
  type WorldData,
} from './finance.steps';

import { state } from './state';

async function capture(world: WorldData, request: ProcessWagerCommand): Promise<void> {
  assertReady(world);
  try {
    state(world).second = await world.processWager.execute(request);
  } catch (error: unknown) {
    state(world).error = error;
  }
}
function queueRequest(original: ProcessWagerCommand, messageId: string): ProcessWagerCommand {
  return { ...original, inbound: { consumerName: 'wager-transactions', messageId } };
}

When<WorldData>('reenvio a mesma chave de aposta com payload divergente', async function () {
  assertReady(this);
  const original = command(this, 'BET', '25.00');
  state(this).original = original;
  state(this).first = await this.processWager.execute(original);
  await capture(this, { ...original, money: original.money.add(original.money) });
});
Then<WorldData>('a segunda operação entra em conflito sem novo débito', async function () {
  assertReady(this);
  assert.ok(state(this).error instanceof IdempotencyConflictError);
  assert.equal(await debitCount(this), 1);
  assert.equal(await currentBalance(this), '75.00');
});
When<WorldData>('reenvio o mesmo external id com outra chave e payload igual', async function () {
  assertReady(this);
  const original = command(this, 'BET', '25.00');
  state(this).original = original;
  state(this).first = await this.processWager.execute(original);
  await capture(this, { ...original, idempotencyKey: `provider-a:other-${randomUUID()}` });
});
Then<WorldData>('ocorre replay sem efeito duplicado', async function () {
  assertReady(this);
  assert.equal(state(this).second?.idempotentReplay, true);
  assert.equal(state(this).second?.transaction.id, state(this).first?.transaction.id);
  assert.equal(await debitCount(this), 1);
  assert.equal(await currentBalance(this), '75.00');
});
When<WorldData>(
  'reenvio o mesmo external id com outra chave e payload divergente',
  async function () {
    assertReady(this);
    const original = command(this, 'BET', '25.00');
    state(this).original = original;
    state(this).first = await this.processWager.execute(original);
    await capture(this, {
      ...original,
      idempotencyKey: `provider-a:other-${randomUUID()}`,
      money: original.money.add(original.money),
    });
  },
);
async function processTwoProviders(world: WorldData, sameKey: boolean): Promise<void> {
  assertReady(world);
  assertWallet(world);
  const first = command(world, 'BET', '25.00');
  state(world).first = await world.processWager.execute(first);
  const second = {
    ...first,
    providerId: 'provider-b',
    idempotencyKey: sameKey ? first.idempotencyKey : `provider-b:${first.externalTransactionId}`,
    correlationId: randomUUID(),
  };
  state(world).second = await world.processWager.execute(second);
  state(world).original = first;
}
When<WorldData>('processo o mesmo external id por dois provedores', async function () {
  await processTwoProviders(this, false);
});
When<WorldData>('processo a mesma chave por dois provedores', async function () {
  await processTwoProviders(this, true);
});
Then<WorldData>('são criadas duas transações independentes', async function () {
  assertReady(this);
  const original = state(this).original;
  assert.ok(original);
  assert.equal(state(this).second?.idempotentReplay, false);
  const rows = await this.database.orm.em
    .getConnection()
    .execute(
      'SELECT COUNT(*)::int AS count FROM wager_transactions WHERE external_transaction_id = ?',
      [original.externalTransactionId],
    );
  const row = rows[0];
  assert.ok(row && typeof row.count === 'number');
  assert.equal(row.count, 2);
  assert.equal(await debitCount(this), 2);
  assert.equal(await currentBalance(this), '50.00');
});
async function queueConflict(world: WorldData, changeKey: boolean): Promise<void> {
  assertReady(world);
  const original = queueRequest(command(world, 'BET', '25.00'), `msg-${randomUUID()}`);
  state(world).original = original;
  state(world).first = await world.processWager.execute(original);
  const redelivery = changeKey
    ? { ...original, idempotencyKey: `provider-a:other-${randomUUID()}` }
    : { ...original, money: original.money.add(original.money) };
  await capture(world, redelivery);
}
When<WorldData>(
  'redeliver a mensagem com o mesmo messageId e payload diferente',
  async function () {
    await queueConflict(this, false);
  },
);
When<WorldData>(
  'redeliver a mensagem com o mesmo messageId e outra chave de idempotência',
  async function () {
    await queueConflict(this, true);
  },
);
Then<WorldData>('a mensagem é recusada por conflito de payload', async function () {
  assertReady(this);
  assert.ok(state(this).error instanceof MessagePayloadConflictError);
  assert.equal(await debitCount(this), 1);
  assert.equal(await currentBalance(this), '75.00');
});
When<WorldData>('redeliver uma mensagem cuja inbox legado não tem fingerprint', async function () {
  assertReady(this);
  const original = queueRequest(command(this, 'BET', '25.00'), `msg-${randomUUID()}`);
  state(this).original = original;
  state(this).first = await this.processWager.execute(original);
  const legacyHash = hashOf({
    providerId: original.providerId,
    externalTransactionId: original.externalTransactionId,
    playerId: original.playerId,
    walletId: original.walletId,
    roundId: original.roundId,
    gameId: original.gameId,
    kind: original.kind,
    money: original.money,
    referenceExternalTransactionId: original.referenceExternalTransactionId,
  });
  await this.database.orm.em
    .getConnection()
    .execute('UPDATE inbox_messages SET payload_hash = ? WHERE message_id = ?', [
      legacyHash,
      original.inbound?.messageId,
    ]);
  await capture(this, { ...original, idempotencyKey: `provider-a:other-${randomUUID()}` });
});
Then<WorldData>('a redelivery é aceita como duplicata compatível', async function () {
  assertReady(this);
  assert.equal(state(this).error, undefined);
  assert.equal(state(this).second?.idempotentReplay, true);
  assert.equal(await debitCount(this), 1);
  assert.equal(await currentBalance(this), '75.00');
});
When<WorldData>('processo o mesmo comando por HTTP e depois por SQS', async function () {
  assertReady(this);
  const original = command(this, 'BET', '25.00');
  state(this).original = original;
  state(this).first = await this.processWager.execute(original);
  state(this).second = await this.processWager.execute(
    queueRequest(original, `msg-${randomUUID()}`),
  );
});
