import type { EntityManager } from '@mikro-orm/postgresql';
import { LEDGER_DIRECTIONS } from '../../../shared/domain/ledger-direction';
import { oneOf } from '../../../shared/infrastructure/database/stored-values';
import { Money } from '../../../shared/domain/money';
import type {
  LedgerPageEntry,
  LedgerSummary,
  WalletLedgerRepository,
} from '../application/ports/wallet-ledger-repository';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WalletLedgerEntryRecord } from './wallet-ledger-entry.record';

export class MikroOrmWalletLedgerRepository implements WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(WalletLedgerEntryRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      currency: entry.money.currency,
      amount: entry.money.toString(),
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      createdAt: entry.createdAt,
    });
  }

  /** Keyset pagination on the sequence: stable under concurrent appends, because entries are never updated. */
  async listPageAfter(
    walletId: string,
    afterSeq: string | undefined,
    limit: number,
  ): Promise<LedgerPageEntry[]> {
    const rows = (await this.em.getConnection().execute(
      `SELECT seq::text AS seq, id, wallet_id, transaction_id, direction, currency,
              amount::text AS amount, balance_before::text AS balance_before,
              balance_after::text AS balance_after, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND (?::bigint IS NULL OR seq > ?::bigint)
        ORDER BY seq
        LIMIT ?`,
      [walletId, afterSeq ?? null, afterSeq ?? null, limit],
    )) as LedgerRow[];
    return rows.map((row) => ({ seq: row.seq, entry: toEntry(row) }));
  }

  /**
   * Recomputes the wallet from its ledger. Every entry is read, so the result is exact, not sampled. The read
   * runs inside the caller's transaction, so it sees the same snapshot as the wallet lock that the caller holds.
   */
  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const rows = (await this.em.execute(
      `SELECT direction, currency, amount::text AS amount, balance_before::text AS balance_before,
              balance_after::text AS balance_after
         FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq`,
      [walletId],
    )) as Array<
      Pick<LedgerRow, 'direction' | 'currency' | 'amount' | 'balance_before' | 'balance_after'>
    >;

    let calculated = Money.zero(currency);
    let chainIntact = true;
    let expectedBefore = Money.zero(currency);
    for (const row of rows) {
      // A row in another currency makes add/subtract throw CURRENCY_MISMATCH, which is the right outcome for a corrupt ledger.
      const amount = Money.from({ amount: row.amount, currency: row.currency });
      const before = Money.from({ amount: row.balance_before, currency: row.currency });
      calculated =
        row.direction === 'CREDIT' ? calculated.add(amount) : calculated.subtract(amount);
      if (!before.equals(expectedBefore)) {
        chainIntact = false;
      }
      expectedBefore = Money.from({ amount: row.balance_after, currency: row.currency });
    }
    return { calculated, entries: rows.length, chainIntact };
  }

  async listByWallet(walletId: string): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      WalletLedgerEntryRecord,
      { walletId },
      { orderBy: { seq: 'asc' }, refresh: true },
    );
    return records.map(toDomain);
  }
}

function toDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
  const currency = record.currency;
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: oneOf(LEDGER_DIRECTIONS, record.direction, 'ledger direction'),
    money: Money.from({ amount: record.amount, currency }),
    balanceBefore: Money.from({ amount: record.balanceBefore, currency }),
    balanceAfter: Money.from({ amount: record.balanceAfter, currency }),
    createdAt: record.createdAt,
  });
}

interface LedgerRow {
  seq: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  currency: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

function toEntry(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: oneOf(LEDGER_DIRECTIONS, row.direction, 'ledger direction'),
    money: Money.from({ amount: row.amount, currency: row.currency }),
    balanceBefore: Money.from({ amount: row.balance_before, currency: row.currency }),
    balanceAfter: Money.from({ amount: row.balance_after, currency: row.currency }),
    // Raw SQL results are not mapped by the ORM, so timestamps arrive as driver values; convert explicitly.
    createdAt: new Date(row.created_at),
  });
}
