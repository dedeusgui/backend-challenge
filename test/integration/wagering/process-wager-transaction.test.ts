import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../../src/shared/application/application-errors';
import { DomainError } from '../../../src/shared/domain/domain-error';
import { Money } from '../../../src/shared/domain/money';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { OpenWallet } from '../../../src/modules/wallet/application/open-wallet.use-case';
import {
  ProcessWagerTransaction,
  type ProcessWagerCommand,
} from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

const NOW = new Date('2026-07-29T15:00:00.000Z');

let database: TestDatabase;
let processWager: ProcessWagerTransaction;
let openWallet: OpenWallet;

beforeAll(async () => {
  database = await createTestDatabase();
  const unitOfWork = new MikroOrmFinancialUnitOfWork(database.orm);
  const dependencies = { unitOfWork, clock: () => NOW, newId: randomUUID };
  processWager = new ProcessWagerTransaction(dependencies);
  openWallet = new OpenWallet(dependencies);
});

afterAll(async () => {
  await database.drop();
});

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

interface FundedWallet {
  walletId: string;
  playerId: string;
}

async function fundedWallet(initialBalance: string): Promise<FundedWallet> {
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await openWallet.execute({
    playerId,
    initialBalance: brl(initialBalance),
  });
  return { walletId, playerId };
}

function command(
  wallet: FundedWallet,
  overrides: Partial<ProcessWagerCommand> & Pick<ProcessWagerCommand, 'kind' | 'money'>,
): ProcessWagerCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `transaction-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    referenceExternalTransactionId: undefined,
    correlationId: `corr-${randomUUID()}`,
    ...overrides,
  };
}

async function balanceOf(walletId: string): Promise<string | undefined> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [walletId])) as Array<{
    balance: string;
  }>;
  return rows[0]?.balance;
}

async function ledgerOf(walletId: string): Promise<Array<{ direction: string; amount: string }>> {
  return (await database.orm.em.getConnection().execute(
    `SELECT direction, amount::text AS amount FROM wallet_ledger_entries
     WHERE wallet_id = ? ORDER BY seq`,
    [walletId],
  )) as Array<{ direction: string; amount: string }>;
}

async function eventTypesOf(aggregateId: string): Promise<string[]> {
  const rows = (await database.orm.em
    .getConnection()
    .execute(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at, event_type`,
      [aggregateId],
    )) as Array<{ event_type: string }>;
  return rows.map((row) => row.event_type);
}

describe('ProcessWagerTransaction: applying operations', () => {
  test('a BET debits the balance once, writes one DEBIT entry and announces the change', async () => {
    const wallet = await fundedWallet('100.00');
    const walletEventsBefore = await eventTypesOf(wallet.walletId);

    const outcome = await processWager.execute(
      command(wallet, { kind: 'BET', money: brl('25.00') }),
    );

    expect(outcome.transaction.status).toBe('PROCESSED');
    expect(outcome.idempotentReplay).toBe(false);
    expect(outcome.balance.toString()).toBe('75.00');
    expect(await balanceOf(wallet.walletId)).toBe('75.00');
    const ledger = await ledgerOf(wallet.walletId);
    expect(ledger.map((entry) => `${entry.direction}:${entry.amount}`)).toEqual([
      'CREDIT:100.00',
      'DEBIT:25.00',
    ]);
    expect(await eventTypesOf(outcome.transaction.id)).toEqual(['WagerTransactionProcessed']);
    expect(await eventTypesOf(wallet.walletId)).toContain('WalletBalanceChanged');
    expect(await eventTypesOf(wallet.walletId)).toHaveLength(walletEventsBefore.length + 1);
  });

  test('a LOSS is processed without moving the balance, the ledger or WalletBalanceChanged', async () => {
    const wallet = await fundedWallet('100.00');
    const ledgerBefore = await ledgerOf(wallet.walletId);
    const walletEventsBefore = await eventTypesOf(wallet.walletId);

    const outcome = await processWager.execute(
      command(wallet, { kind: 'LOSS', money: brl('25.00') }),
    );

    expect(outcome.transaction.status).toBe('PROCESSED');
    expect(outcome.balance.toString()).toBe('100.00');
    expect(await ledgerOf(wallet.walletId)).toEqual(ledgerBefore);
    expect(await eventTypesOf(outcome.transaction.id)).toEqual(['WagerTransactionProcessed']);
    expect(await eventTypesOf(wallet.walletId)).toEqual(walletEventsBefore);
  });

  test('a WIN credits the wallet', async () => {
    const wallet = await fundedWallet('100.00');

    const outcome = await processWager.execute(
      command(wallet, { kind: 'WIN', money: brl('40.00') }),
    );

    expect(outcome.transaction.status).toBe('PROCESSED');
    expect(outcome.balance.toString()).toBe('140.00');
    expect((await ledgerOf(wallet.walletId)).at(-1)).toEqual({
      direction: 'CREDIT',
      amount: '40.00',
    });
  });

  test('a BET the balance cannot cover is REJECTED, with no balance or ledger effect', async () => {
    const wallet = await fundedWallet('10.00');
    const ledgerBefore = await ledgerOf(wallet.walletId);

    const outcome = await processWager.execute(
      command(wallet, { kind: 'BET', money: brl('25.00') }),
    );

    expect(outcome.transaction.status).toBe('REJECTED');
    expect(outcome.transaction.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(outcome.balance.toString()).toBe('10.00');
    expect(await balanceOf(wallet.walletId)).toBe('10.00');
    expect(await ledgerOf(wallet.walletId)).toEqual(ledgerBefore);
    expect(await eventTypesOf(outcome.transaction.id)).toEqual(['WagerTransactionRejected']);
  });
});

describe('ProcessWagerTransaction: idempotency', () => {
  test('a repeated identical request replays the original result and the balance seen back then', async () => {
    const wallet = await fundedWallet('100.00');
    const bet = command(wallet, { kind: 'BET', money: brl('25.00') });
    const first = await processWager.execute(bet);
    await processWager.execute(command(wallet, { kind: 'WIN', money: brl('50.00') }));

    const replay = await processWager.execute(bet);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.balance.toString()).toBe('75.00');
    expect(await balanceOf(wallet.walletId)).toBe('125.00');
    expect((await ledgerOf(wallet.walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(
      1,
    );
  });

  test('the same idempotency key with a different payload is a conflict and writes nothing', async () => {
    const wallet = await fundedWallet('100.00');
    const original = command(wallet, { kind: 'BET', money: brl('25.00') });
    await processWager.execute(original);
    const ledgerBefore = await ledgerOf(wallet.walletId);

    const attempt = processWager.execute({ ...original, money: brl('30.00') });

    await expect(attempt).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await ledgerOf(wallet.walletId)).toEqual(ledgerBefore);
    expect(await balanceOf(wallet.walletId)).toBe('75.00');
  });

  test('the same external transaction under another key with the same payload replays', async () => {
    const wallet = await fundedWallet('100.00');
    const original = command(wallet, { kind: 'BET', money: brl('25.00') });
    const first = await processWager.execute(original);

    const replay = await processWager.execute({
      ...original,
      idempotencyKey: 'provider-a:another-key',
    });

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
  });

  test('the same external transaction under another key with a different payload is a conflict', async () => {
    const wallet = await fundedWallet('100.00');
    const original = command(wallet, { kind: 'BET', money: brl('25.00') });
    await processWager.execute(original);

    const attempt = processWager.execute({
      ...original,
      idempotencyKey: 'provider-a:another-key',
      money: brl('26.00'),
    });

    await expect(attempt).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe('ProcessWagerTransaction: references', () => {
  test('a REFUND credits the referenced BET back, and only once', async () => {
    const wallet = await fundedWallet('100.00');
    const bet = command(wallet, {
      kind: 'BET',
      money: brl('25.00'),
      externalTransactionId: 'bet-1',
    });
    await processWager.execute(bet);

    const refund = await processWager.execute(
      command(wallet, {
        kind: 'REFUND',
        money: brl('25.00'),
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    const secondRefund = await processWager.execute(
      command(wallet, {
        kind: 'REFUND',
        money: brl('25.00'),
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    expect(refund.transaction.status).toBe('PROCESSED');
    expect(refund.balance.toString()).toBe('100.00');
    expect(secondRefund.transaction.status).toBe('REJECTED');
    expect(secondRefund.transaction.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
  });

  test('a REFUND that arrives before its BET waits as PENDING_REFERENCE and announces it', async () => {
    const wallet = await fundedWallet('100.00');

    const outcome = await processWager.execute(
      command(wallet, {
        kind: 'REFUND',
        money: brl('25.00'),
        referenceExternalTransactionId: 'bet-late',
      }),
    );

    expect(outcome.transaction.status).toBe('PENDING_REFERENCE');
    expect(outcome.balance.toString()).toBe('100.00');
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    expect(await eventTypesOf(outcome.transaction.id)).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });

  test('a REFUND of a BET that was rejected is rejected as REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await fundedWallet('10.00');
    await processWager.execute(
      command(wallet, { kind: 'BET', money: brl('25.00'), externalTransactionId: 'bet-rejected' }),
    );

    const outcome = await processWager.execute(
      command(wallet, {
        kind: 'REFUND',
        money: brl('25.00'),
        referenceExternalTransactionId: 'bet-rejected',
      }),
    );

    expect(outcome.transaction.status).toBe('REJECTED');
    expect(outcome.transaction.failureCode).toBe('REFERENCE_NOT_PROCESSED');
  });

  test('a ROLLBACK of a WIN the balance has already spent is REVERSAL_WOULD_OVERDRAW, not insufficient balance', async () => {
    const wallet = await fundedWallet('0.00');
    await processWager.execute(
      command(wallet, { kind: 'WIN', money: brl('50.00'), externalTransactionId: 'win-1' }),
    );
    await processWager.execute(command(wallet, { kind: 'BET', money: brl('50.00') }));

    const outcome = await processWager.execute(
      command(wallet, {
        kind: 'ROLLBACK',
        money: brl('50.00'),
        referenceExternalTransactionId: 'win-1',
      }),
    );

    expect(outcome.transaction.status).toBe('REJECTED');
    expect(outcome.transaction.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    expect(outcome.balance.toString()).toBe('0.00');
  });

  test('a ROLLBACK reverses the direction of its reference', async () => {
    const wallet = await fundedWallet('100.00');
    await processWager.execute(
      command(wallet, { kind: 'BET', money: brl('25.00'), externalTransactionId: 'bet-2' }),
    );

    const outcome = await processWager.execute(
      command(wallet, {
        kind: 'ROLLBACK',
        money: brl('25.00'),
        referenceExternalTransactionId: 'bet-2',
      }),
    );

    expect(outcome.transaction.status).toBe('PROCESSED');
    expect(outcome.balance.toString()).toBe('100.00');
    expect((await ledgerOf(wallet.walletId)).at(-1)).toEqual({
      direction: 'CREDIT',
      amount: '25.00',
    });
  });

  test('a reversal whose amount differs from the reference is rejected', async () => {
    const wallet = await fundedWallet('100.00');
    await processWager.execute(
      command(wallet, { kind: 'BET', money: brl('25.00'), externalTransactionId: 'bet-3' }),
    );

    const outcome = await processWager.execute(
      command(wallet, {
        kind: 'REFUND',
        money: brl('20.00'),
        referenceExternalTransactionId: 'bet-3',
      }),
    );

    expect(outcome.transaction.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
  });

  test('a reversal from another round cannot reverse a BET', async () => {
    const wallet = await fundedWallet('100.00');
    await processWager.execute(
      command(wallet, { kind: 'BET', money: brl('25.00'), externalTransactionId: 'bet-4' }),
    );

    const outcome = await processWager.execute(
      command(wallet, {
        kind: 'REFUND',
        money: brl('25.00'),
        referenceExternalTransactionId: 'bet-4',
        roundId: 'round-other',
      }),
    );

    expect(outcome.transaction.failureCode).toBe('REFERENCE_CONTEXT_MISMATCH');
  });
});

describe('ProcessWagerTransaction: validation and wallet checks', () => {
  test('OPENING cannot be submitted by a provider and nothing is written', async () => {
    const wallet = await fundedWallet('100.00');
    const ledgerBefore = await ledgerOf(wallet.walletId);

    const attempt = processWager.execute(command(wallet, { kind: 'OPENING', money: brl('1.00') }));

    await expect(attempt).rejects.toBeInstanceOf(DomainError);
    expect(await ledgerOf(wallet.walletId)).toEqual(ledgerBefore);
  });

  test('an unknown wallet is an application error and nothing is written', async () => {
    const ghost: FundedWallet = { walletId: randomUUID(), playerId: 'nobody' };

    const attempt = processWager.execute(command(ghost, { kind: 'BET', money: brl('1.00') }));

    await expect(attempt).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('a currency other than the wallet currency is REJECTED with WALLET_CURRENCY_MISMATCH', async () => {
    const wallet = await fundedWallet('100.00');

    const outcome = await processWager.execute(
      command(wallet, { kind: 'BET', money: Money.from({ amount: '25.00', currency: 'USD' }) }),
    );

    expect(outcome.transaction.failureCode).toBe('WALLET_CURRENCY_MISMATCH');
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
  });

  test('a player who does not own the wallet is REJECTED with WALLET_PLAYER_MISMATCH', async () => {
    const wallet = await fundedWallet('100.00');

    const outcome = await processWager.execute(
      command({ ...wallet, playerId: 'someone-else' }, { kind: 'BET', money: brl('25.00') }),
    );

    expect(outcome.transaction.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
  });
});
