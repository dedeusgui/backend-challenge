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

/**
 * A lease is a claim that another publisher must respect while it still holds it. Whether a lease is still held
 * is decided by the database clock, which every publisher shares. A publisher whose own clock runs behind must
 * not be able to write a lease that is already expired, and so must not let another publisher take an event that
 * the first is still sending.
 */

const CLOCK_SKEW_MS = 60 * 60 * 1000;

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ verifyLedgerInvariant: false });
});

afterAll(async () => {
  await database.drop();
});

/**
 * Commits events scheduled two hours in the past, so that every publisher in these tests sees them as due,
 * including one whose clock runs an hour behind.
 */
async function committedEvents(count: number): Promise<void> {
  const dependencies = {
    unitOfWork: new MikroOrmFinancialUnitOfWork(database.orm),
    clock: () => new Date(Date.now() - 2 * 60 * 60 * 1000),
    newId: randomUUID,
  };
  const openWallet = new OpenWallet(dependencies);
  const processWager = new ProcessWagerTransaction(dependencies);
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '500.00', currency: 'BRL' }),
  });
  for (let index = 0; index < count; index += 1) {
    await processWager.execute({
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
}

/** A transport that records each event it is asked to send, and holds the send until the test releases it. */
class HoldingTransport implements OutboxTransport {
  readonly sent: string[] = [];
  private started: () => void = () => undefined;
  readonly sendStarted = new Promise<void>((resolve) => {
    this.started = resolve;
  });
  private release: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async publish(
    messages: readonly OutboxTransportMessage[],
  ): Promise<readonly OutboxTransportFailure[]> {
    this.started();
    await this.gate;
    for (const message of messages) {
      this.sent.push(message.id);
    }
    return [];
  }

  releaseSend(): void {
    this.release();
  }
}

class RecordingTransport implements OutboxTransport {
  readonly sent: string[] = [];

  async publish(
    messages: readonly OutboxTransportMessage[],
  ): Promise<readonly OutboxTransportFailure[]> {
    for (const message of messages) {
      this.sent.push(message.id);
    }
    return [];
  }
}

function publisherWith(transport: OutboxTransport, clock: () => Date): OutboxPublisher {
  return new OutboxPublisher({
    store: new MikroOrmOutboxStore(database.orm),
    transport,
    clock,
    newLeaseToken: randomUUID,
    leaseDurationMs: 30_000,
    batchSize: 50,
  });
}

describe('the outbox lease is decided by the database clock', () => {
  test('a publisher whose clock runs an hour behind cannot hand over an event that another publisher is still sending', async () => {
    await committedEvents(2);
    const behindTransport = new HoldingTransport();
    const correctTransport = new RecordingTransport();
    const behind = publisherWith(behindTransport, () => new Date(Date.now() - CLOCK_SKEW_MS));
    const correct = publisherWith(correctTransport, () => new Date());

    const inFlight = behind.publishOnce();
    await behindTransport.sendStarted;
    const takenByOther = await correct.publishOnce();
    behindTransport.releaseSend();
    const published = await inFlight;

    expect(takenByOther).toBe(0);
    expect(correctTransport.sent).toEqual([]);
    expect(published).toBe(behindTransport.sent.length);
  });

  test('a publisher whose clock runs an hour ahead cannot take an event that another publisher is still sending', async () => {
    await committedEvents(2);
    const holdingTransport = new HoldingTransport();
    const aheadTransport = new RecordingTransport();
    const correct = publisherWith(holdingTransport, () => new Date());
    const ahead = publisherWith(aheadTransport, () => new Date(Date.now() + CLOCK_SKEW_MS));

    const inFlight = correct.publishOnce();
    await holdingTransport.sendStarted;
    const takenByAhead = await ahead.publishOnce();
    holdingTransport.releaseSend();
    const published = await inFlight;

    expect(takenByAhead).toBe(0);
    expect(aheadTransport.sent).toEqual([]);
    expect(published).toBe(holdingTransport.sent.length);
  });
});
