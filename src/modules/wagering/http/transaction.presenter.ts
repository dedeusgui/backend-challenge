import type { WagerTransaction } from '../domain/wager-transaction';
import type { ProcessWagerOutcome } from '../application/process-wager-transaction.use-case';

export interface WagerTransactionResponse {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

/**
 * Status codes are chosen so a provider can decide on retry from the code alone:
 * 201/200 applied, 202 accepted and waiting for a reference, 422 rejected by a
 * business rule (do not resend unchanged). 503 and 409 come from the error filter.
 */
export function wagerOutcomeHttpStatus(outcome: ProcessWagerOutcome): number {
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

export function presentWagerOutcome(outcome: ProcessWagerOutcome): WagerTransactionResponse {
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

export function presentTransaction(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    resultingBalance: transaction.resultingBalance?.toJSON() ?? null,
    processedAt: transaction.processedAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
  };
}
