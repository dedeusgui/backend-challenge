import { DomainError } from '../../../shared/domain/domain-error';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | undefined;
}

/**
 * Deduplication record for an inbound message, identified by (consumerName, messageId).
 * It is written in the same transaction as the effect it guards, so a received
 * message that was not processed never persists.
 */
export class InboxMessage {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  private currentProcessedAt: Date | undefined;

  private constructor(state: InboxMessageState) {
    this.messageId = state.messageId;
    this.consumerName = state.consumerName;
    this.payloadHash = state.payloadHash;
    this.receivedAt = state.receivedAt;
    this.currentProcessedAt = state.processedAt;
  }

  static receive(props: Omit<InboxMessageState, 'processedAt'>): InboxMessage {
    return new InboxMessage({ ...props, processedAt: undefined });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state);
  }

  get processedAt(): Date | undefined {
    return this.currentProcessedAt;
  }

  isProcessed(): boolean {
    return this.currentProcessedAt !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new DomainError(
        'INVALID_INBOX_TRANSITION',
        `Inbox message ${this.messageId} is already processed`,
      );
    }
    this.currentProcessedAt = at;
  }
}
