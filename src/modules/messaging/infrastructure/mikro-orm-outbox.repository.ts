import type { EntityManager } from '@mikro-orm/postgresql';
import type { IntegrationEvent } from '../../../shared/domain/integration-event';
import type { OutboxRepository } from '../application/outbox-repository.port';
import { OutboxMessage } from '../domain/outbox-message';
import { OutboxMessageRecord } from './outbox.record';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(event: IntegrationEvent<unknown>): Promise<void> {
    const message = OutboxMessage.enqueue(event);
    await this.em.insert(OutboxMessageRecord, {
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
    });
  }
}
