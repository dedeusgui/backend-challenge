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

/**
 * A refused event waits out its backoff on the database clock. A publisher whose own clock runs an hour behind
 * must not turn that backoff into an immediate retry: the next attempt is written from the database's now().
 */

const ONE_HOUR = 60 * 60 * 1000;

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ verifyLedgerInvariant: false });
}, 60_000);

afterAll(async () => {
  await database.drop();
});

/** Refuses every event it is given, and counts the sends. */
class RefusingTransport implements OutboxTransport {
  sends = 0;

  async publish(
    messages: readonly OutboxTransportMessage[],
  ): Promise<readonly OutboxTransportFailure[]> {
    this.sends += 1;
    return messages.map((message) => ({ id: message.id, error: new Error('broker is down') }));
  }
}

async function committedEvents(): Promise<void> {
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
}

describe('a refused event waits out its backoff on the database clock', () => {
  test('a publisher whose clock runs an hour behind does not retry a refused event at once', async () => {
    await committedEvents();
    const transport = new RefusingTransport();
    const behind = new OutboxPublisher({
      store: new MikroOrmOutboxStore(database.orm),
      transport,
      clock: () => new Date(Date.now() - ONE_HOUR),
      newLeaseToken: randomUUID,
      leaseDurationMs: 30_000,
      batchSize: 50,
    });

    expect(await behind.publishOnce()).toBe(0);
    const sendsAfterFirst = transport.sends;
    expect(await behind.publishOnce()).toBe(0);

    expect(sendsAfterFirst).toBe(1);
    expect(transport.sends).toBe(1);
    const rows = (await database.orm.em.getConnection().execute(
      `SELECT EXTRACT(EPOCH FROM (next_attempt_at - now()))::text AS seconds_until_next
         FROM outbox_messages WHERE published_at IS NULL AND attempts = 1 LIMIT 1`,
    )) as Array<{ seconds_until_next: string }>;
    const seconds = Number(required(rows[0], 'a refused event').seconds_until_next);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(2);
  });
});
