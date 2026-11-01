import { DomainError } from '../../../../shared/domain/domain-error';
import {
  IntegrationEvent,
  type IntegrationEventContext,
} from '../../../../shared/domain/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { WagerTransaction } from '../wager-transaction';

interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string;
}

/** Published when a transaction is held until its referenced transaction arrives. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: IntegrationEventContext,
  ): WagerTransactionPendingReference {
    if (
      transaction.status !== 'PENDING_REFERENCE' ||
      transaction.referenceExternalTransactionId === undefined
    ) {
      throw new DomainError(
        'INVALID_TRANSACTION',
        'Only a transaction awaiting a reference can be announced as pending',
      );
    }
    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      },
    });
  }
}
