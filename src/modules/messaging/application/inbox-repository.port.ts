import type { InboxMessage } from '../domain/inbox-message';

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  insert(message: InboxMessage): Promise<void>;
}
