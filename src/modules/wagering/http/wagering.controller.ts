import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import {
  OPERATION_LOGGER,
  type OperationLogger,
} from '../../../shared/observability/structured-log';
import { randomUUID } from 'node:crypto';
import {
  ProcessWagerTransaction,
  type ProcessWagerOutcome,
} from '../application/process-wager-transaction.use-case';
import { parseProcessWagerRequest } from './process-wager.request';
import { expectCorrelationId, expectUuid } from '../../../shared/validation/request-validation';
import { WagerQueries } from '../application/wager-queries';
import { presentTransaction } from './transaction.presenter';
import { CurrentPrincipal, requireProviderScope } from '../../auth/http/access';
import type { Principal } from '../../auth/domain/principal';

/** The subset of the Express response this controller needs. Keeps the controller independent of Express types. */
interface StatusSetter {
  status(code: number): unknown;
}

export interface WagerTransactionResponse {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: WagerQueries,
    @Inject(OPERATION_LOGGER) private readonly logger: OperationLogger,
  ) {}

  @Get(':transactionId')
  async getById(
    @CurrentPrincipal() principal: Principal,
    @Param('transactionId') transactionId: string,
  ) {
    const transaction = await this.queries.getById(expectUuid(transactionId, 'transactionId'));
    requireProviderScope(principal, transaction.providerId);
    return presentTransaction(transaction);
  }

  @Post()
  async submit(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<WagerTransactionResponse> {
    const { command } = parseProcessWagerRequest(body, idempotencyKey);
    requireProviderScope(principal, command.providerId);
    const resolvedCorrelationId = expectCorrelationId(correlationId) ?? randomUUID();
    const started = performance.now();
    const outcome = await this.processWager.execute({
      ...command,
      correlationId: resolvedCorrelationId,
    });
    this.logger({
      operation: 'wager.submit',
      status: outcome.transaction.status,
      correlationId: resolvedCorrelationId,
      transactionId: outcome.transaction.id,
      walletId: outcome.transaction.walletId,
      providerId: outcome.transaction.providerId,
      durationMs: Math.round(performance.now() - started),
    });
    response.status(statusOf(outcome));
    return presentOutcome(outcome);
  }
}

/**
 * Status codes are chosen so a provider can decide on retry from the code alone:
 * 201/200 applied, 202 accepted and waiting for a reference, 422 rejected by a
 * business rule (do not resend unchanged). 503 and 409 come from the error filter.
 */
function statusOf(outcome: ProcessWagerOutcome): number {
  switch (outcome.transaction.status) {
    case 'PROCESSED':
      return outcome.idempotentReplay ? 200 : 201;
    case 'PENDING_REFERENCE':
      return 202;
    case 'REJECTED':
      return 422;
    default:
      return 500;
  }
}

function presentOutcome(outcome: ProcessWagerOutcome): WagerTransactionResponse {
  const response: WagerTransactionResponse = {
    transactionId: outcome.transaction.id,
    status: outcome.transaction.status,
    balance: outcome.balance.toJSON(),
    idempotentReplay: outcome.idempotentReplay,
  };
  const failureCode = outcome.transaction.failureCode;
  if (failureCode !== undefined) {
    response.failureCode = failureCode;
  }
  return response;
}
