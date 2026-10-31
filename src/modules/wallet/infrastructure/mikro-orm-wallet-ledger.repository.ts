import type { EntityManager } from '@mikro-orm/postgresql';
import { LEDGER_DIRECTIONS } from '../../../shared/domain/ledger-direction';
import { oneOf } from '../../../shared/infrastructure/database/stored-values';
import { Money } from '../../../shared/domain/money';
import type { WalletLedgerRepository } from '../application/wallet-ledger-repository.port';
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
