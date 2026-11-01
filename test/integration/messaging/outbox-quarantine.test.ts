import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { OutboxPublisher } from '../../../src/modules/messaging/application/outbound/outbox-publisher';
import type {
  OutboxTransport,
  OutboxTransportFailure,
  OutboxTransportMessage,
} from '../../../src/modules/messaging/application/ports/outbox-transport';
import { MikroOrmOutboxStore } from '../../../src/modules/messaging/infrastructure/mikro-orm-outbox.store';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransaction } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { required } from '../../support/required';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ verifyLedgerInvariant: false });
}, 60_000);

afterAll(async () => {
  await database.drop();
});

class SelectiveTransport implements OutboxTransport {
  readonly sent: string[] = [];
  failingId = '';

  async publish(
    messages: readonly OutboxTransportMessage[],
  ): Promise<readonly OutboxTransportFailure[]> {
    const failures: OutboxTransportFailure[] = [];
    for (const message of messages) {
      if (message.id === this.failingId) {
        failures.push({ id: message.id, error: new Error('injected permanent broker failure') });
      } else {
        this.sent.push(message.id);
      }
    }
    return failures;
  }
}

async function committedEvents(): Promise<string[]> {
  const dependencies = {
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => new Date(),
    newId: randomUUID,
  };
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await new OpenWallet(dependencies).execute({
    playerId,
    initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
  });
  await new ProcessWagerTransaction(dependencies).execute({
    idempotencyKey: `k-${randomUUID()}`,
    providerId: 'provider-a',
    externalTransactionId: `t-${randomUUID()}`,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.from({ amount: '1.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    correlationId: 'corr',
  });
  const rows = (await database.orm.em
    .getConnection()
    .execute(
      `SELECT id FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at, id`,
    )) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

describe('outbox quarantine', () => {
  test('quarantines repeated failures without blocking healthy events and supports requeue', async () => {
    const ids = await committedEvents();
    const failedId = required(ids[0], 'a failed event id');
    const healthyId = required(ids[1], 'a healthy event id');
    const transport = new SelectiveTransport();
    transport.failingId = failedId;
    const store = new MikroOrmOutboxStore(database.orm);
    const publisher = new OutboxPublisher({
      store,
      transport,
      clock: () => new Date(),
      newLeaseToken: randomUUID,
      leaseDurationMs: 30_000,
      batchSize: 50,
      maxAttempts: 2,
    });

    expect(await publisher.publishOnce()).toBeGreaterThan(0);
    await database.orm.em
      .getConnection()
      .execute(`UPDATE outbox_messages SET next_attempt_at = now() WHERE id = ?`, [failedId]);
    await publisher.publishOnce();
    const quarantined = (await database.orm.em
      .getConnection()
      .execute(`SELECT status, attempts FROM outbox_messages WHERE id = ?`, [failedId])) as Array<{
      status: string;
      attempts: number;
    }>;
    expect(quarantined[0]).toEqual({ status: 'QUARANTINED', attempts: 2 });
    expect(transport.sent).toContain(healthyId);

    await database.orm.em
      .getConnection()
      .execute(`UPDATE outbox_messages SET next_attempt_at = now() WHERE id = ?`, [failedId]);
    expect(await publisher.publishOnce()).toBe(0);

    const requeued = await store.requeue(failedId);
    expect(requeued).toBe(true);
    const pending = (await database.orm.em
      .getConnection()
      .execute(
        `SELECT status, attempts, next_attempt_at <= now() AS due FROM outbox_messages WHERE id = ?`,
        [failedId],
      )) as Array<{ status: string; attempts: number; due: boolean }>;
    expect(pending[0]).toEqual({ status: 'PENDING', attempts: 0, due: true });
  });
});
