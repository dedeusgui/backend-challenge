import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../../shared/application/application-errors';
import type { InboxRepository } from '../application/inbox-repository.port';
import { InboxMessage } from '../domain/inbox-message';
import { InboxMessageRecord } from './inbox.record';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(
      InboxMessageRecord,
      { consumerName, messageId },
      { refresh: true },
    );
    if (!record) {
      return undefined;
    }
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  }

  /** A unique violation means a concurrent delivery of the same message recorded it first: a lost race. */
  async insert(message: InboxMessage): Promise<void> {
    try {
      await this.em.insert(InboxMessageRecord, {
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.processedAt ?? null,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConcurrencyConflictError(
          `Message ${message.messageId} was recorded concurrently`,
        );
      }
      throw error;
    }
  }
}
