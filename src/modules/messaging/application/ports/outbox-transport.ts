/** The external system an event is published to. The SQS adapter is the only implementation. */
export interface OutboxTransportMessage {
  id: string;
  aggregateId: string;
  payload: unknown;
}

/** An event the transport did not send, and why. An event that is not listed was sent. */
export interface OutboxTransportFailure {
  id: string;
  error: unknown;
}

export interface OutboxTransport {
  /**
   * Sends the events in the given order, in as few broker requests as the broker allows, and resolves
   * with the events it did not send. A throw means that none of them was sent.
   */
  publish(messages: readonly OutboxTransportMessage[]): Promise<readonly OutboxTransportFailure[]>;
}
