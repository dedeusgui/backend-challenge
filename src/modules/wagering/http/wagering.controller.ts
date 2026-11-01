import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import {
  OPERATION_LOGGER,
  type OperationLogger,
} from '../../../shared/observability/structured-log';
import { METRICS_REGISTRY, type MetricsSink } from '../../../shared/observability/metrics';
import { randomUUID } from 'node:crypto';
import { ProcessWagerTransaction } from '../application/process-wager-transaction.use-case';
import { parseProcessWagerRequest } from './process-wager.request';
import { expectCorrelationId, expectUuid } from '../../../shared/validation/request-validation';
import { WagerQueries } from '../application/wager-queries';
import {
  presentTransaction,
  presentWagerOutcome,
  wagerOutcomeHttpStatus,
  type WagerTransactionResponse,
} from './transaction.presenter';
import { CurrentPrincipal, requireProviderScope } from '../../auth/http/access';
import { canOperateFor, type Principal } from '../../auth/domain/principal';
import { TransactionNotFoundError } from '../../../shared/application/application-errors';
import type { StatusSetter } from '../../../shared/http/status-setter';

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: WagerQueries,
    @Inject(OPERATION_LOGGER) private readonly logger: OperationLogger,
    @Inject(METRICS_REGISTRY) private readonly metrics: MetricsSink,
  ) {}

  @Get(':transactionId')
  async getById(
    @CurrentPrincipal() principal: Principal,
    @Param('transactionId') transactionId: string,
  ) {
    const transaction = await this.queries.getById(expectUuid(transactionId, 'transactionId'));
    // A transaction of another provider answers exactly like a missing one. A 403 here would tell a
    // provider that the id exists in someone else's data.
    if (!canOperateFor(principal, transaction.providerId)) {
      throw new TransactionNotFoundError(transactionId);
    }
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
    const validateStarted = performance.now();
    const { command } = parseProcessWagerRequest(body, idempotencyKey);
    this.metrics.observe('request_validation_ms', performance.now() - validateStarted);
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
    response.status(wagerOutcomeHttpStatus(outcome));
    return presentWagerOutcome(outcome);
  }
}
