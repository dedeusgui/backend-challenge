import { Controller, Get, Param } from '@nestjs/common';
import { CurrentPrincipal, requireProviderScope } from '../../auth/http/access';
import type { Principal } from '../../auth/domain/principal';
import { WagerQueries } from '../application/wager-queries';
import { presentTransaction } from './transaction.presenter';
import { expectText } from '../../../shared/validation/request-validation';

/** Lookup by the provider's own identifier, which is how providers refer to their transactions. */
@Controller('providers')
export class ProvidersController {
  constructor(private readonly queries: WagerQueries) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @CurrentPrincipal() principal: Principal,
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    requireProviderScope(principal, providerId);
    return presentTransaction(
      await this.queries.getByExternalId(
        expectText(providerId, 'providerId'),
        expectText(externalTransactionId, 'externalTransactionId'),
      ),
    );
  }
}
