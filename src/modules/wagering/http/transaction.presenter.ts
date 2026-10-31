import type { WagerTransaction } from '../domain/wager-transaction';

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
