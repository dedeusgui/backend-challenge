import { DomainError } from '../../../../shared/domain/domain-error';
import {
  IntegrationEvent,
  type IntegrationEventContext,
} from '../../../../shared/domain/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { FailureCode } from '../failure-code';
import type { WagerTransaction } from '../wager-transaction';

export interface WagerTransactionFailedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  failureCode: FailureCode;
  observedBalance?: MoneyProps;
}

/**
 * Published when a held transaction fails permanently and is recorded FAILED. No money moves: the balance is the one
 * the transaction was held with.
 */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: IntegrationEventContext,
  ): WagerTransactionFailed {
    if (transaction.status !== 'FAILED' || transaction.failureCode === undefined) {
      throw new DomainError(
        'INVALID_TRANSACTION',
        'Only a failed transaction can be announced as failed',
      );
    }
    return new WagerTransactionFailed({
      ...context,
      aggregateId: transaction.id,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode: transaction.failureCode,
        observedBalance: transaction.resultingBalance?.toJSON(),
      },
    });
  }
}
