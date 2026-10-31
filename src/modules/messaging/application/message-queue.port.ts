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

/** A FIFO queue as the application sees it. The SQS adapter is the only implementation. */
export interface MessageQueue {
  send(body: string, groupId: string, deduplicationId: string): Promise<void>;
  receive(options: ReceiveOptions): Promise<ReceivedMessage[]>;
  acknowledge(receiptHandle: string): Promise<void>;
  changeVisibility(receiptHandle: string, seconds: number): Promise<void>;
}
