import type { IntegrationEvent } from '../../../../shared/domain/integration-event';

export interface OutboxRepository {
  /**
   * Stores the events in the current transaction, in one insert. They are published only after that
   * transaction commits.
   */
  enqueue(...events: IntegrationEvent<unknown>[]): Promise<void>;
}
