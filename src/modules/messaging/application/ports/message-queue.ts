export interface ReceivedMessage {
  receiptHandle: string;
  body: string;
  /** How many times the queue has delivered this message, including this delivery. */
  receiveCount: number;
}

export interface ReceiveOptions {
  maxMessages: number;
  waitSeconds: number;
  visibilityTimeoutSeconds: number;
}

/**
 * Inbound: receive, acknowledge, changeVisibility and extendVisibility; outbound: send for events and DLQ.
 * A FIFO queue as the application sees it. The SQS adapter is the only implementation.
 */
export interface MessageQueue {
  send(body: string, groupId: string, deduplicationId: string): Promise<void>;
  receive(options: ReceiveOptions): Promise<ReceivedMessage[]>;
  acknowledge(receiptHandle: string): Promise<void>;
  changeVisibility(receiptHandle: string, seconds: number): Promise<void>;
  /**
   * Sets the visibility of up to ten received messages in one request, each to `seconds` from now.
   * Rejects when the broker refuses any of them, so the caller never assumes an extension that did not happen.
   */
  extendVisibility(receiptHandles: readonly string[], seconds: number): Promise<void>;
}
