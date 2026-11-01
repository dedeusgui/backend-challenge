import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MessagePayloadConflictError } from '../../../src/shared/application/application-errors';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { Money } from '../../../src/shared/domain/money';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { hashOf } from '../../../src/modules/wagering/domain/wager-payload';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * A queue message is identified by its messageId. The inbox records a fingerprint of the message
 * and refuses a second delivery of the same messageId whose content differs. The message carries an
 * idempotencyKey, so a change of that key is a change of content, and it must not be accepted as a
 * duplicate of the original.
 */

const CONSUMER = 'wager-transactions';
const START = new Date('2026-07-29T15:00:00.000Z');

let database: TestDatabase;
let processWager: ProcessWagerTransaction;
let openWallet: OpenWallet;

beforeAll(async () => {
  database = await createTestDatabase();
  const dependencies = {
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => START,
    newId: randomUUID,
  };
  processWager = new ProcessWagerTransaction(dependencies);
  openWallet = new OpenWallet(dependencies);
});

afterAll(async () => {
  await database.drop();
});

async function openedWallet() {
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '500.00', currency: 'BRL' }),
  });
  return { playerId, walletId };
}

function betMessage(
  wallet: { playerId: string; walletId: string },
  externalTransactionId: string,
  idempotencyKey: string,
  messageId: string,
): ProcessWagerCommand {
  return {
    idempotencyKey,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    correlationId: messageId,
    inbound: { consumerName: CONSUMER, messageId },
  };
}

describe('a redelivered queue message', () => {
  test('the same message with the same content is a duplicate, and answers with the original result', async () => {
    const wallet = await openedWallet();
    const messageId = `msg-${randomUUID()}`;
    const externalTransactionId = `t-${randomUUID()}`;
    const first = await processWager.execute(
      betMessage(wallet, externalTransactionId, `provider-a:${externalTransactionId}`, messageId),
    );
    const again = await processWager.execute(
      betMessage(wallet, externalTransactionId, `provider-a:${externalTransactionId}`, messageId),
    );

    expect(first.idempotentReplay).toBe(false);
    expect(again.idempotentReplay).toBe(true);
    expect(again.transaction.id).toBe(first.transaction.id);
  });

  test('the same messageId with a different business field is refused as a payload conflict', async () => {
    const wallet = await openedWallet();
    const messageId = `msg-${randomUUID()}`;
    const externalTransactionId = `t-${randomUUID()}`;
    await processWager.execute(
      betMessage(wallet, externalTransactionId, `provider-a:${externalTransactionId}`, messageId),
    );

    const altered = {
      ...betMessage(
        wallet,
        externalTransactionId,
        `provider-a:${externalTransactionId}`,
        messageId,
      ),
      money: Money.from({ amount: '11.00', currency: 'BRL' }),
    };
    await expect(processWager.execute(altered)).rejects.toBeInstanceOf(MessagePayloadConflictError);
  });

  test('the same messageId with a different idempotencyKey is refused, not accepted as a duplicate', async () => {
    const wallet = await openedWallet();
    const messageId = `msg-${randomUUID()}`;
    const externalTransactionId = `t-${randomUUID()}`;
    await processWager.execute(
      betMessage(wallet, externalTransactionId, `provider-a:${externalTransactionId}`, messageId),
    );

    // Same business fields, so the transaction itself is the same; only the message content differs.
    const altered = betMessage(
      wallet,
      externalTransactionId,
      `provider-a:other-${randomUUID()}`,
      messageId,
    );
    await expect(processWager.execute(altered)).rejects.toBeInstanceOf(MessagePayloadConflictError);
  });

  test('a row recorded before message fingerprints is still compared on the business fields only', async () => {
    const wallet = await openedWallet();
    const messageId = `msg-${randomUUID()}`;
    const externalTransactionId = `t-${randomUUID()}`;
    const original = betMessage(
      wallet,
      externalTransactionId,
      `provider-a:${externalTransactionId}`,
      messageId,
    );
    await processWager.execute(original);

    // Simulate the row an earlier release wrote: the business payload hash, without the key.
    const {
      idempotencyKey: _key,
      correlationId: _correlation,
      inbound: _inbound,
      ...business
    } = original;
    const legacyHash = hashOf({
      providerId: business.providerId,
      externalTransactionId: business.externalTransactionId,
      playerId: business.playerId,
      walletId: business.walletId,
      roundId: business.roundId,
      gameId: business.gameId,
      kind: business.kind,
      money: business.money,
      referenceExternalTransactionId: business.referenceExternalTransactionId,
    });
    await database.orm.em
      .getConnection()
      .execute(`UPDATE inbox_messages SET payload_hash = ? WHERE message_id = ?`, [
        legacyHash,
        messageId,
      ]);

    const rekeyed = betMessage(
      wallet,
      externalTransactionId,
      `provider-a:other-${randomUUID()}`,
      messageId,
    );
    await expect(processWager.execute(rekeyed)).resolves.toMatchObject({ idempotentReplay: true });

    const altered = { ...rekeyed, money: Money.from({ amount: '11.00', currency: 'BRL' }) };
    await expect(processWager.execute(altered)).rejects.toBeInstanceOf(MessagePayloadConflictError);
  });
});
