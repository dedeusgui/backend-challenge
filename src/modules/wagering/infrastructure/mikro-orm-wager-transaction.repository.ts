import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../shared/domain/money';
import type { WagerTransactionRepository } from '../application/wager-transaction-repository.port';
import { oneOf, nullableToOptional } from '../../../shared/infrastructure/database/stored-values';
import { FAILURE_CODES } from '../domain/failure-code';
import { WAGER_TRANSACTION_KINDS } from '../domain/wager-transaction-kind';
import {
  WAGER_TRANSACTION_STATUSES,
  WagerTransaction,
  type WagerTransactionState,
} from '../domain/wager-transaction';
import { WagerTransactionRecord } from './wager-transaction.record';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, toRecordData(transaction.toState()));
  }

  async findById(transactionId: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { id: transactionId },
      { refresh: true },
    );
    return record ? WagerTransaction.rehydrate(toState(record)) : undefined;
  }
}

function toRecordData(state: WagerTransactionState) {
  return {
    id: state.id,
    providerId: state.providerId,
    externalTransactionId: state.externalTransactionId,
    idempotencyKey: state.idempotencyKey,
    payloadHash: state.payloadHash,
    walletId: state.walletId,
    playerId: state.playerId,
    roundId: state.roundId,
    gameId: state.gameId,
    kind: state.kind,
    amount: state.money.toString(),
    currency: state.money.currency,
    referenceExternalTransactionId: state.referenceExternalTransactionId ?? null,
    referenceTransactionId: state.referenceTransactionId ?? null,
    status: state.status,
    failureCode: state.failureCode ?? null,
    resultingBalance: state.resultingBalance?.toString() ?? null,
    processedAt: state.processedAt ?? null,
    createdAt: state.createdAt,
  };
}

function toState(record: WagerTransactionRecord): WagerTransactionState {
  const currency = record.currency;
  return {
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: oneOf(WAGER_TRANSACTION_KINDS, record.kind, 'transaction kind'),
    money: Money.from({ amount: record.amount, currency }),
    referenceExternalTransactionId: nullableToOptional(record.referenceExternalTransactionId),
    createdAt: record.createdAt,
    status: oneOf(WAGER_TRANSACTION_STATUSES, record.status, 'transaction status'),
    referenceTransactionId: nullableToOptional(record.referenceTransactionId),
    failureCode: parseFailureCode(record.failureCode),
    resultingBalance: parseOptionalMoney(record.resultingBalance, currency),
    processedAt: nullableToOptional(record.processedAt),
  };
}

function parseFailureCode(stored: string | null | undefined) {
  const value = nullableToOptional(stored);
  return value === undefined ? undefined : oneOf(FAILURE_CODES, value, 'failure code');
}

function parseOptionalMoney(stored: string | null | undefined, currency: string) {
  const amount = nullableToOptional(stored);
  return amount === undefined ? undefined : Money.from({ amount, currency });
}
