import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  STATUS_TRANSITIONS,
  WAGER_TRANSACTION_STATUSES,
  canChangeStatus,
  type WagerTransactionStatus,
} from '../../../src/modules/wagering/domain/wager-lifecycle';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * The row guards of migration 10: the database refuses an update that breaks the transaction lifecycle or the
 * wallet version rule. Every status change is checked against the domain table, so the two cannot drift.
 * The rows here do not balance against any ledger on purpose; the ledger checks are not part of this suite.
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ verifyLedgerInvariant: false });
});

afterAll(async () => {
  await database.drop();
});

/** Resolves true when the database accepted the statement, false when a guard or constraint refused it. */
async function accepted(sql: string, params: unknown[]): Promise<boolean> {
  try {
    await database.orm.em.getConnection().execute(sql, params);
    return true;
  } catch {
    return false;
  }
}

async function insertWallet(balance = '100.00', version = 1): Promise<string> {
  const id = randomUUID();
  await database.orm.em.getConnection().execute(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES (?, ?, 'BRL', ?, ?, now(), now())`,
    [id, `player-${randomUUID()}`, balance, version],
  );
  return id;
}

/** The columns that a status needs, so that the row satisfies wager_status_shape before the test changes it. */
function shapeOf(status: WagerTransactionStatus): Record<string, unknown> {
  switch (status) {
    case 'PENDING':
      return {
        processed_at: null,
        resulting_balance: null,
        failure_code: null,
        reference_next_attempt_at: null,
      };
    case 'PENDING_REFERENCE':
      return {
        processed_at: null,
        resulting_balance: '100.00',
        failure_code: null,
        reference_next_attempt_at: 'now',
      };
    case 'PROCESSED':
      return {
        processed_at: 'now',
        resulting_balance: '100.00',
        failure_code: null,
        reference_next_attempt_at: null,
      };
    case 'REJECTED':
    case 'FAILED':
      return {
        processed_at: null,
        resulting_balance: '100.00',
        failure_code: 'INSUFFICIENT_BALANCE',
        reference_next_attempt_at: null,
      };
  }
}

/** Inserts a BET in the given status, with a wallet of its own. */
async function insertTransaction(
  status: WagerTransactionStatus,
): Promise<{ id: string; walletId: string }> {
  const walletId = await insertWallet();
  const id = randomUUID();
  const externalId = `tx-${randomUUID()}`;
  const shape = shapeOf(status);
  await database.orm.em.getConnection().execute(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency, status, failure_code, resulting_balance,
        processed_at, reference_attempts, reference_next_attempt_at, created_at)
     VALUES (?, 'provider-a', ?, ?, ?, ?, 'player', 'round-1', 'game-1', 'BET', 25.00, 'BRL', ?, ?, ?,
        ${shape.processed_at === 'now' ? 'now()' : 'NULL'}, 0,
        ${shape.reference_next_attempt_at === 'now' ? 'now()' : 'NULL'}, now())`,
    [
      id,
      externalId,
      `provider-a:${externalId}`,
      '0'.repeat(64),
      walletId,
      status,
      shape.failure_code,
      shape.resulting_balance,
    ],
  );
  return { id, walletId };
}

/** The values a status change sets, so that the target row satisfies the shape of the target status. */
function targetFields(status: WagerTransactionStatus): {
  status: string;
  processed: boolean;
  failure: string | null;
  resulting: string | null;
  next: boolean;
} {
  const shape = shapeOf(status);
  return {
    status,
    processed: shape.processed_at === 'now',
    failure: (shape.failure_code as string | null) ?? null,
    resulting: (shape.resulting_balance as string | null) ?? null,
    next: shape.reference_next_attempt_at === 'now',
  };
}

describe('the status change of a transaction follows the domain table', () => {
  // A change to the same status is not a status change: it is checked by the other tests of this file.
  for (const from of WAGER_TRANSACTION_STATUSES) {
    for (const to of WAGER_TRANSACTION_STATUSES) {
      if (from === to) {
        continue;
      }
      const allowed = canChangeStatus(from, to);
      test(`${from} to ${to} is ${allowed ? 'accepted' : 'refused'}, as the lifecycle table says`, async () => {
        const { id } = await insertTransaction(from);
        const target = targetFields(to);

        const ok = await accepted(
          `UPDATE wager_transactions
              SET status = ?,
                  processed_at = ${target.processed ? 'now()' : 'NULL'},
                  failure_code = ?,
                  resulting_balance = ?,
                  reference_next_attempt_at = ${target.next ? 'now()' : 'NULL'}
            WHERE id = ?`,
          [target.status, target.failure, target.resulting, id],
        );

        expect(ok).toBe(allowed);
      });
    }
  }

  test('the lifecycle table has seven status changes, which the pairs above exercise', () => {
    // The pairs above cover all 20 changes between different statuses. Seven of them are allowed.
    const allowedCount = WAGER_TRANSACTION_STATUSES.reduce(
      (sum, from) => sum + STATUS_TRANSITIONS[from].filter((to) => to !== from).length,
      0,
    );
    expect(allowedCount).toBe(7);
  });
});

describe('a transaction keeps its identity and its payload', () => {
  test.each([
    ['amount', 'amount = 26.00'],
    ['kind', "kind = 'WIN'"],
    ['payload_hash', `payload_hash = '${'b'.repeat(64)}'`],
    ['idempotency_key', "idempotency_key = 'other-key'"],
    ['round_id', "round_id = 'round-2'"],
    ['created_at', "created_at = now() - interval '1 day'"],
  ])('%s never changes, whatever the status', async (_column, assignment) => {
    const { id } = await insertTransaction('PENDING');
    expect(await accepted(`UPDATE wager_transactions SET ${assignment} WHERE id = ?`, [id])).toBe(
      false,
    );
  });

  test('a terminal transaction does not change, even in a field the lifecycle does not name', async () => {
    const { id } = await insertTransaction('PROCESSED');
    expect(
      await accepted(`UPDATE wager_transactions SET resulting_balance = 99.00 WHERE id = ?`, [id]),
    ).toBe(false);
    expect(
      await accepted(`UPDATE wager_transactions SET processed_at = now() WHERE id = ?`, [id]),
    ).toBe(false);
  });

  test('an update that writes the same values to a terminal transaction changes nothing, so it is accepted', async () => {
    const { id } = await insertTransaction('REJECTED');
    expect(
      await accepted(`UPDATE wager_transactions SET failure_code = failure_code WHERE id = ?`, [
        id,
      ]),
    ).toBe(true);
  });

  test('the reference attempt count only grows', async () => {
    const { id } = await insertTransaction('PENDING_REFERENCE');
    expect(
      await accepted(`UPDATE wager_transactions SET reference_attempts = 2 WHERE id = ?`, [id]),
    ).toBe(true);
    expect(
      await accepted(`UPDATE wager_transactions SET reference_attempts = 1 WHERE id = ?`, [id]),
    ).toBe(false);
    expect(
      await accepted(`UPDATE wager_transactions SET reference_attempts = 3 WHERE id = ?`, [id]),
    ).toBe(true);
  });

  test('a missed reference lookup may repeat the held status, and it moves the next attempt', async () => {
    const { id } = await insertTransaction('PENDING_REFERENCE');
    expect(
      await accepted(
        `UPDATE wager_transactions SET reference_attempts = 1, reference_next_attempt_at = now() + interval '2 seconds' WHERE id = ?`,
        [id],
      ),
    ).toBe(true);
  });
});

describe('a wallet changes its balance and its version together, by one', () => {
  test('a balance change with the version bumped by one is accepted', async () => {
    const id = await insertWallet('100.00', 1);
    expect(
      await accepted(`UPDATE wallets SET balance = 75.00, version = 2 WHERE id = ?`, [id]),
    ).toBe(true);
  });

  test('a balance change without a version bump is refused: the optimistic lock would be lost', async () => {
    const id = await insertWallet('100.00', 1);
    expect(await accepted(`UPDATE wallets SET balance = 75.00 WHERE id = ?`, [id])).toBe(false);
  });

  test('a balance change that bumps the version by more than one is refused', async () => {
    const id = await insertWallet('100.00', 1);
    expect(
      await accepted(`UPDATE wallets SET balance = 75.00, version = 3 WHERE id = ?`, [id]),
    ).toBe(false);
  });

  test('a version change without a balance change is refused: the version moves only with the balance', async () => {
    const id = await insertWallet('100.00', 1);
    expect(await accepted(`UPDATE wallets SET version = 2 WHERE id = ?`, [id])).toBe(false);
  });

  test('the player and the currency of a wallet never change', async () => {
    const id = await insertWallet('100.00', 1);
    expect(await accepted(`UPDATE wallets SET player_id = 'someone-else' WHERE id = ?`, [id])).toBe(
      false,
    );
    expect(await accepted(`UPDATE wallets SET currency = 'USD' WHERE id = ?`, [id])).toBe(false);
  });

  test('an update that writes the same balance and version is accepted', async () => {
    const id = await insertWallet('100.00', 1);
    expect(
      await accepted(`UPDATE wallets SET balance = balance, version = version WHERE id = ?`, [id]),
    ).toBe(true);
  });
});
