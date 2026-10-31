import type { EntityManager } from '@mikro-orm/postgresql';
import type { IntegrationEvent } from '../../../shared/domain/integration-event';
import type { OutboxRepository } from '../application/outbox-repository.port';
import { OutboxMessage } from '../domain/outbox-message';
import { OutboxMessageRecord } from './outbox.record';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(...events: IntegrationEvent<unknown>[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await this.em.insertMany(
      OutboxMessageRecord,
      events.map((event) => {
        const message = OutboxMessage.enqueue(event);
        return {
          id: message.id,
          aggregateId: message.aggregateId,
          eventType: message.eventType,
          payload: message.payload,
          occurredAt: message.occurredAt,
          attempts: message.attempts,
          nextAttemptAt: message.nextAttemptAt,
          publishedAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        };
      }),
    );
  }
}
