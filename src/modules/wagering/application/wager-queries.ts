import type { ApplicationContext } from '../../../shared/application/application-context';
import { TransactionNotFoundError } from '../../../shared/application/application-errors';
import type { WagerTransaction } from '../domain/wager-transaction';

/** Read-side lookups of wager transactions. No wallet lock: reads never wait for financial writes. */
export class WagerQueries {
  constructor(private readonly context: ApplicationContext) {}

  async getById(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.context.unitOfWork.run((repositories) =>
      repositories.wagers.findById(transactionId),
    );
    if (transaction === undefined) {
      throw new TransactionNotFoundError(transactionId);
    }
    return transaction;
  }

  async getByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const transaction = await this.context.unitOfWork.run((repositories) =>
      repositories.wagers.findByExternalId(providerId, externalTransactionId),
    );
    if (transaction === undefined) {
      throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    }
    return transaction;
  }
}
