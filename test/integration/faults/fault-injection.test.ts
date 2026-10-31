import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type {
  FinancialRepositories,
  FinancialUnitOfWork,
} from '../../../src/shared/application/ports/financial-unit-of-work.port';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { ProcessPendingReferences } from '../../../src/modules/wagering/application/process-pending-references.use-case';
import {
  OutboxPublisher,
  type OutboxTransport,
} from '../../../src/modules/messaging/application/outbox-publisher';
import type { OutboxStore } from '../../../src/modules/messaging/application/outbox-store.port';
import { MikroOrmOutboxStore } from '../../../src/modules/messaging/infrastructure/mikro-orm-outbox.store';
import { SqsEventTransport } from '../../../src/modules/messaging/infrastructure/sqs/sqs-event-transport';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, testSqsClient, type TestQueues } from '../support/sqs-test-queues';

/**
 * Fault injection at the critical points. The wrappers below sit around real components
 * (the unit of work, the outbox store) and fail exactly once, on demand. Production code
 * carries none of this.
 */

const NOW = new Date('2026-07-29T15:00:00.000Z');
const LEASE_MS = 30_000;

let database: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;
let real: FinancialUnitOfWork;
let openWallet: OpenWallet;

beforeAll(async () => {
  database = await createTestDatabase();
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
  real = new MikroOrmFinancialUnitOfWork(database.orm);
  openWallet = new OpenWallet({ unitOfWork: real, clock: () => NOW, newId: randomUUID });
});

afterAll(async () => {
  await database.drop();
});

/** Fails once, after the work has run and before the transaction commits. */
class CrashBeforeCommit implements FinancialUnitOfWork {
  armed = false;

  constructor(private readonly inner: FinancialUnitOfWork) {}

  run<T>(work: (repositories: FinancialRepositories) => Promise<T>): Promise<T> {
    return this.inner.run(async (repositories) => {
      const result = await work(repositories);
      if (this.armed) {
        this.armed = false;
        throw new Error('injected crash before commit');
      }
      return result;
    });
  }
}

/** Fails once on the outbox "mark published" step, after the broker has accepted the event. */
class CrashBeforeMark implements OutboxStore {
  armed = true;

  constructor(private readonly inner: OutboxStore) {}

  claimDue(request: Parameters<OutboxStore['claimDue']>[0]) {
    return this.inner.claimDue(request);
  }

  complete(message: Parameters<OutboxStore['complete']>[0], token: string, at: Date) {
    if (this.armed) {
      this.armed = false;
      return Promise.reject(new Error('injected crash after broker accepted, before mark'));
    }
    return this.inner.complete(message, token, at);
  }

  reschedule(message: Parameters<OutboxStore['reschedule']>[0], token: string) {
    return this.inner.reschedule(message, token);
  }
}

function command(
  walletId: string,
  playerId: string,
  overrides: Partial<ProcessWagerCommand> & Pick<ProcessWagerCommand, 'kind' | 'money'>,
): ProcessWagerCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `f-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    referenceExternalTransactionId: undefined,
    correlationId: 'corr',
    ...overrides,
  };
}

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  const rows = (await database.orm.em.getConnection().execute(sql, params)) as Array<
    Record<string, string>
  >;
  return Object.values(rows[0] ?? {})[0] ?? '';
}

async function wallet(amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount, currency: 'BRL' }),
  });
  return { walletId, playerId };
}

describe('fault injection', () => {
  test('a crash before commit leaves no trace, and the retry applies the operation exactly once', async () => {
    const funds = await wallet('100.00');
    const crashing = new CrashBeforeCommit(real);
    const externalTransactionId = `f-${randomUUID()}`;
    const bet = command(funds.walletId, funds.playerId, {
      kind: 'BET',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      externalTransactionId,
    });

    crashing.armed = true;
    await expect(
      new ProcessWagerTransaction({
        unitOfWork: crashing,
        clock: () => NOW,
        newId: randomUUID,
      }).execute(bet),
    ).rejects.toThrow('injected crash before commit');

    expect(
      await scalar(
        `SELECT count(*)::text FROM wager_transactions WHERE external_transaction_id = ?`,
        [externalTransactionId],
      ),
    ).toBe('0');
    // Events are written in the same transaction, so a rolled-back operation announces nothing.
    expect(
      await scalar(`SELECT count(*)::text FROM outbox_messages WHERE payload::text LIKE ?`, [
        `%${externalTransactionId}%`,
      ]),
    ).toBe('0');
    expect(await scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [funds.walletId])).toBe(
      '100.00',
    );
    expect(
      await scalar(
        `SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [funds.walletId],
      ),
    ).toBe('0');

    const retried = await new ProcessWagerTransaction({
      unitOfWork: real,
      clock: () => NOW,
      newId: randomUUID,
    }).execute(bet);

    expect(retried.transaction.status).toBe('PROCESSED');
    expect(await scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [funds.walletId])).toBe(
      '75.00',
    );
    expect(
      await scalar(
        `SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [funds.walletId],
      ),
    ).toBe('1');
  });

  test('a crash after the broker accepted an event and before it is marked published republishes with the same event id', async () => {
    const funds = await wallet('100.00');
    await new ProcessWagerTransaction({
      unitOfWork: real,
      clock: () => NOW,
      newId: randomUUID,
    }).execute(
      command(funds.walletId, funds.playerId, {
        kind: 'BET',
        money: Money.from({ amount: '5.00', currency: 'BRL' }),
      }),
    );
    const sends = new Map<string, number>();
    const transport: OutboxTransport = {
      publish: async (message) => {
        sends.set(message.id, (sends.get(message.id) ?? 0) + 1);
        await new SqsEventTransport(new SqsQueue(sqs, queues.eventsQueueUrl)).publish(message);
      },
    };
    const store = new CrashBeforeMark(new MikroOrmOutboxStore(database.orm));
    const publisherAt = (at: Date, batchSize = 1) =>
      new OutboxPublisher({
        store,
        transport,
        clock: () => at,
        newLeaseToken: randomUUID,
        leaseDurationMs: LEASE_MS,
        batchSize,
      });

    const firstAttempt = publisherAt(NOW);
    await expect(firstAttempt.publishOnce()).rejects.toThrow(
      'injected crash after broker accepted',
    );
    const crashedEvent = [...sends.keys()][0] ?? '';
    expect(sends.get(crashedEvent)).toBe(1);
    expect(
      await scalar(
        `SELECT count(*)::text FROM outbox_messages WHERE id = ? AND published_at IS NULL`,
        [crashedEvent],
      ),
    ).toBe('1');

    const afterLeaseExpiry = new Date(NOW.getTime() + LEASE_MS + 1_000);
    // Drain every due event. The crashed one is due again once its lease has expired.
    const drain = publisherAt(afterLeaseExpiry, 50);
    while ((await drain.publishOnce()) > 0) {
      // keep draining
    }

    expect(sends.get(crashedEvent)).toBe(2);
    expect(
      await scalar(
        `SELECT count(*)::text FROM outbox_messages WHERE id = ? AND published_at IS NOT NULL`,
        [crashedEvent],
      ),
    ).toBe('1');
  });

  test('a crash while resolving a held reference rolls back, and the next pass applies it exactly once', async () => {
    const funds = await wallet('100.00');
    const refundId = `held-${randomUUID()}`;
    const create = new ProcessWagerTransaction({
      unitOfWork: real,
      clock: () => NOW,
      newId: randomUUID,
    });
    await create.execute(
      command(funds.walletId, funds.playerId, {
        kind: 'REFUND',
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        externalTransactionId: refundId,
        referenceExternalTransactionId: 'bet-held',
      }),
    );
    await create.execute(
      command(funds.walletId, funds.playerId, {
        kind: 'BET',
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        externalTransactionId: 'bet-held',
      }),
    );
    const later = new Date(NOW.getTime() + 3_600_000);
    const crashing = new CrashBeforeCommit(real);
    crashing.armed = true;

    await expect(
      new ProcessPendingReferences({
        unitOfWork: crashing,
        clock: () => later,
        newId: randomUUID,
      }).runOnce(),
    ).rejects.toThrow('injected crash before commit');
    expect(
      await scalar(`SELECT status FROM wager_transactions WHERE external_transaction_id = ?`, [
        refundId,
      ]),
    ).toBe('PENDING_REFERENCE');
    expect(await scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [funds.walletId])).toBe(
      '75.00',
    );

    await new ProcessPendingReferences({
      unitOfWork: real,
      clock: () => later,
      newId: randomUUID,
    }).runOnce();

    expect(
      await scalar(`SELECT status FROM wager_transactions WHERE external_transaction_id = ?`, [
        refundId,
      ]),
    ).toBe('PROCESSED');
    expect(await scalar(`SELECT balance::text FROM wallets WHERE id = ?`, [funds.walletId])).toBe(
      '100.00',
    );
    expect(
      await scalar(
        `SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'`,
        [funds.walletId],
      ),
    ).toBe('2');
  });
});
