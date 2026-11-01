import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';

/**
 * Proof for the experiment in docs/audit/experiments/ledger-agreement-triggers.sql. The triggers were measured
 * and rejected from the write path (docs/audit/PERFORMANCE_COMPARISON.md). This file shows that the candidate
 * refuses each write that the schema accepts without it. It is not part of the gate: run it with
 * `bun test test/experiments`.
 *
 * The rows are written the way a faulty writer would write them. Each write runs in its own transaction, so
 * the refusal is the commit's.
 */

const EXPERIMENT_SQL = new URL(
  '../../docs/audit/experiments/ledger-agreement-triggers.sql',
  import.meta.url,
);

let database: TestDatabase;

beforeAll(async () => {
  // The rows below break the ledger invariant on purpose. Verification is off so that the teardown does not fail.
  database = await createTestDatabase({ verifyLedgerInvariant: false });
  await database.orm.em.getConnection().execute(await Bun.file(EXPERIMENT_SQL).text());
});

afterAll(async () => {
  await database.drop();
});

interface Wallet {
  walletId: string;
  playerId: string;
}

/** Inserts a processed wager transaction for the wallet, and returns its id. Each ledger row needs its own. */
async function processedTransaction(
  em: EntityManager,
  wallet: Wallet,
  kind: 'OPENING' | 'BET',
  amount: string,
): Promise<string> {
  const id = randomUUID();
  const externalId = `${kind.toLowerCase()}-${id}`;
  await em.execute(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency, status, resulting_balance,
        processed_at, created_at)
     VALUES (?, 'provider-a', ?, ?, ?, ?, ?, 'round-1', 'game-1', ?, ?, 'BRL', 'PROCESSED', 0.00, now(), now())`,
    [id, externalId, externalId, '0'.repeat(64), wallet.walletId, wallet.playerId, kind, amount],
  );
  return id;
}

/** Opens a wallet with 100.00 the way the application does: a wallet row, an OPENING transaction and its entry. */
async function openedWallet(): Promise<Wallet> {
  const wallet: Wallet = { walletId: randomUUID(), playerId: `player-${randomUUID()}` };
  await database.orm.em.transactional(async (em) => {
    await em.execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', 100.00, 1, now(), now())`,
      [wallet.walletId, wallet.playerId],
    );
    const opening = await processedTransaction(em, wallet, 'OPENING', '100.00');
    await em.execute(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount,
          balance_before, balance_after, created_at)
       VALUES (?, ?, ?, 'CREDIT', 'BRL', 100.00, 0.00, 100.00, now())`,
      [randomUUID(), wallet.walletId, opening],
    );
  });
  return wallet;
}

/** Runs `write` in one transaction. Resolves true when the commit succeeded, false when the database refused it. */
async function commits(write: (em: EntityManager) => Promise<void>): Promise<boolean> {
  try {
    await database.orm.em.transactional(write);
    return true;
  } catch {
    return false;
  }
}

/** A debit of `amount` from `balanceBefore`, written as the application writes it: a BET, the balance, and the entry. */
async function debit(
  em: EntityManager,
  wallet: Wallet,
  amount: string,
  balanceBefore: string,
  balanceAfter: string,
  moveBalance: boolean,
): Promise<void> {
  const transaction = await processedTransaction(em, wallet, 'BET', amount);
  if (moveBalance) {
    await em.execute(`UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ?`, [
      balanceAfter,
      wallet.walletId,
    ]);
  }
  await em.execute(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount,
        balance_before, balance_after, created_at)
     VALUES (?, ?, ?, 'DEBIT', 'BRL', ?, ?, ?, now())`,
    [randomUUID(), wallet.walletId, transaction, amount, balanceBefore, balanceAfter],
  );
}

describe('a balance change and its ledger entry agree at commit', () => {
  test('a balance change with no ledger entry is refused at commit', async () => {
    const wallet = await openedWallet();

    const committed = await commits(async (em) => {
      await em.execute(`UPDATE wallets SET balance = 105.00, version = version + 1 WHERE id = ?`, [
        wallet.walletId,
      ]);
    });

    expect(committed).toBe(false);
  });

  test('a ledger entry that does not continue the previous balance is refused at commit', async () => {
    const wallet = await openedWallet();

    // The chain says 50.00 came before, but the wallet's last entry ends at 100.00. The wallet row moves to match.
    const committed = await commits((em) => debit(em, wallet, '10.00', '50.00', '40.00', true));

    expect(committed).toBe(false);
  });

  test('a ledger entry whose balance_after is not the wallet balance is refused at commit', async () => {
    const wallet = await openedWallet();

    // The entry continues the chain and is arithmetically right, but the wallet row is not moved to match it.
    const committed = await commits((em) => debit(em, wallet, '10.00', '100.00', '90.00', false));

    expect(committed).toBe(false);
  });

  test('a debit whose balance change and entry are written together is accepted', async () => {
    const wallet = await openedWallet();

    const committed = await commits((em) => debit(em, wallet, '10.00', '100.00', '90.00', true));

    expect(committed).toBe(true);
  });
});
