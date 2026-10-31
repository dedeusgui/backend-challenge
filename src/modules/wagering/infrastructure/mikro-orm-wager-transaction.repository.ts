import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../../shared/application/application-errors';
import { Money } from '../../../shared/domain/money';
import { nullableToOptional, oneOf } from '../../../shared/infrastructure/database/stored-values';
import type {
  ProcessedOutcomes,
  WagerTransactionRepository,
} from '../application/wager-transaction-repository.port';
import { FAILURE_CODES } from '../domain/failure-code';
import {
  WAGER_TRANSACTION_STATUSES,
  WagerTransaction,
  type WagerTransactionState,
} from '../domain/wager-transaction';
import { WAGER_TRANSACTION_KINDS } from '../domain/wager-transaction-kind';
import { WagerTransactionRecord } from './wager-transaction.record';

type WagerLookup = Partial<
  Pick<WagerTransactionRecord, 'id' | 'providerId' | 'idempotencyKey' | 'externalTransactionId'>
>;

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  /** A unique violation means a concurrent transaction committed the same identity first. */
  async insert(transaction: WagerTransaction): Promise<void> {
    try {
      await this.em.insert(WagerTransactionRecord, toRecordData(transaction.toState()));
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConcurrencyConflictError(
          `Transaction ${transaction.id} collides with a committed identity`,
        );
      }
      throw error;
    }
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const { id, ...fields } = toRecordData(transaction.toState());
    await this.em.nativeUpdate(WagerTransactionRecord, { id }, fields);
  }

  async findDueForReferenceLookup(now: Date, limit: number): Promise<WagerTransaction[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { status: 'PENDING_REFERENCE', referenceNextAttemptAt: { $lte: now } },
      { orderBy: { referenceNextAttemptAt: 'asc' }, limit, refresh: true },
    );
    return records.map((record) => WagerTransaction.rehydrate(toState(record)));
  }

  async findById(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ id: transactionId });
  }

  /** Both unique keys are checked by one query, which returns at most one row per key. */
  async findByIdentity(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { providerId, $or: [{ idempotencyKey }, { externalTransactionId }] },
      { refresh: true },
    );
    const record =
      records.find((candidate) => candidate.idempotencyKey === idempotencyKey) ??
      records.find((candidate) => candidate.externalTransactionId === externalTransactionId);
    return record === undefined ? undefined : WagerTransaction.rehydrate(toState(record));
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ providerId, externalTransactionId });
  }

  /**
   * At most one reversal and one settlement can be processed against a reference, so the answer is
   * short. Each arm of the OR matches one of the partial unique indexes on the reference. A single
   * `kind IN (...)` over all four kinds matches neither, and PostgreSQL then scans the table (measured).
   */
  async processedOutcomesOf(referenceTransactionId: string): Promise<ProcessedOutcomes> {
    const records = await this.em.find(WagerTransactionRecord, {
      referenceTransactionId,
      status: 'PROCESSED',
      $or: [{ kind: { $in: ['REFUND', 'ROLLBACK'] } }, { kind: { $in: ['WIN', 'LOSS'] } }],
    });
    return {
      reversed: records.some((record) => record.kind === 'REFUND' || record.kind === 'ROLLBACK'),
      settled: records.some((record) => record.kind === 'WIN' || record.kind === 'LOSS'),
    };
  }

  private async findOneBy(where: WagerLookup): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, where, { refresh: true });
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
    referenceAttempts: state.referenceAttempts,
    referenceNextAttemptAt: state.referenceNextAttemptAt ?? null,
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
    referenceAttempts: record.referenceAttempts,
    referenceNextAttemptAt: nullableToOptional(record.referenceNextAttemptAt),
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
