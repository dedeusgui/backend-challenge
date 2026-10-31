import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ProcessWagerTransaction,
  type ProcessWagerOutcome,
} from '../application/process-wager-transaction.use-case';
import { parseProcessWagerRequest } from './process-wager.request';

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
  constructor(private readonly processWager: ProcessWagerTransaction) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<WagerTransactionResponse> {
    const { command } = parseProcessWagerRequest(body, idempotencyKey);
    const outcome = await this.processWager.execute({
      ...command,
      correlationId: correlationId ?? randomUUID(),
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
