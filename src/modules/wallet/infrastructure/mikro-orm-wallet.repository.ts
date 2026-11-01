import {
  UniqueConstraintViolationException,
  type EntityManager,
  LockMode,
} from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  WalletAlreadyExistsError,
} from '../../../shared/application/application-errors';
import { Money } from '../../../shared/domain/money';
import type { WalletRepository } from '../application/ports/wallet-repository';
import { Wallet } from '../domain/wallet';
import { WalletRecord } from './wallet.record';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id: walletId }, { refresh: true });
    return record ? toDomain(record) : undefined;
  }

  /** `refresh` makes the lock query hit the database even when the identity map already holds the row. */
  async findForUpdate(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? toDomain(record) : undefined;
  }

  /** A shared lock blocks writers and lets other readers through, so reconciliation never sees a half-applied debit. */
  async findForShare(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_READ, refresh: true },
    );
    return record ? toDomain(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, toRecordData(wallet));
    } catch (error) {
      this.handleInsertError(error, wallet.playerId, wallet.currency);
    }
  }

  private handleInsertError(error: unknown, playerId: string, currency: string): never {
    if (error instanceof UniqueConstraintViolationException) {
      throw new WalletAlreadyExistsError(playerId, currency);
    }
    throw error;
  }

  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      {
        balance: wallet.balance.toString(),
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (updated !== 1) {
      throw new ConcurrencyConflictError(
        `Wallet ${wallet.id} was modified concurrently (expected version ${expectedVersion})`,
      );
    }
  }
}

function toDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function toRecordData(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
