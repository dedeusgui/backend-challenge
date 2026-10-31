/**
 * Application-level failures. They are not HTTP concepts: the HTTP and queue
 * adapters decide how each one is reported, acknowledged or retried.
 */

/** A concurrent transaction committed the same identity first. The unit of work rolled back, so nothing was applied. */
export class ConcurrencyConflictError extends Error {
  readonly code = 'CONCURRENCY_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}

/** The idempotency key or the external transaction id was already used with a different payload. */
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class WalletNotFoundError extends Error {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} does not exist`);
    this.name = 'WalletNotFoundError';
  }
}

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`A ${currency} wallet already exists for player ${playerId}`);
    this.name = 'WalletAlreadyExistsError';
  }
}

/** A message id was reused with a different payload. The message is permanently invalid for this consumer. */
export class MessagePayloadConflictError extends Error {
  readonly code = 'MESSAGE_PAYLOAD_CONFLICT';

  constructor(messageId: string) {
    super(`Message ${messageId} was already received with a different payload`);
    this.name = 'MessagePayloadConflictError';
  }
}

export class TransactionNotFoundError extends Error {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`Transaction ${reference} does not exist`);
    this.name = 'TransactionNotFoundError';
  }
}
