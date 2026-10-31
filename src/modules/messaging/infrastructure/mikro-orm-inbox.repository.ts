import type { EntityManager } from '@mikro-orm/postgresql';
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

  async insert(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageRecord, {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
  }
}
