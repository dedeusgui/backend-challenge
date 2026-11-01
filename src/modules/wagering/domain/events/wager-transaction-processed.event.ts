import { DomainError } from '../../../../shared/domain/domain-error';
import {
  IntegrationEvent,
  type IntegrationEventContext,
} from '../../../../shared/domain/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { WagerTransaction } from '../wager-transaction';

interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  resultingBalance: MoneyProps;
}

/** Published for every applied transaction, including LOSS (which moves no balance). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: IntegrationEventContext,
  ): WagerTransactionProcessed {
    if (transaction.status !== 'PROCESSED' || transaction.resultingBalance === undefined) {
      throw new DomainError(
        'INVALID_TRANSACTION',
        'Only a processed transaction can be announced as processed',
      );
    }
    return new WagerTransactionProcessed({
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
        resultingBalance: transaction.resultingBalance.toJSON(),
      },
    });
  }
}
