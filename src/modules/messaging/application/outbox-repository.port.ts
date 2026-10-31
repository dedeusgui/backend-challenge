import type { IntegrationEvent } from '../../../shared/domain/integration-event';

export interface OutboxRepository {
  /** Stores the event in the current transaction. It is published only after that transaction commits. */
  enqueue(event: IntegrationEvent<unknown>): Promise<void>;
}
