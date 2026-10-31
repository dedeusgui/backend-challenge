import { DomainError } from '../../../../shared/domain/domain-error';
import {
  IntegrationEvent,
  type IntegrationEventContext,
} from '../../../../shared/domain/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { FailureCode } from '../failure-code';
import type { WagerTransaction } from '../wager-transaction';

export interface WagerTransactionRejectedData {
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

/** Published when a business rule rejects a transaction. Rejections move no money. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: IntegrationEventContext,
  ): WagerTransactionRejected {
    if (transaction.status !== 'REJECTED' || transaction.failureCode === undefined) {
      throw new DomainError(
        'INVALID_TRANSACTION',
        'Only a rejected transaction can be announced as rejected',
      );
    }
    return new WagerTransactionRejected({
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
