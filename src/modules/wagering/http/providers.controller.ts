import { Controller, Get, Param } from '@nestjs/common';
import { WagerQueries } from '../application/wager-queries';
import { presentTransaction } from './transaction.presenter';

/** Lookup by the provider's own identifier, which is how providers refer to their transactions. */
@Controller('providers')
export class ProvidersController {
  constructor(private readonly queries: WagerQueries) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return presentTransaction(
      await this.queries.getByExternalId(providerId, externalTransactionId),
    );
  }
}
