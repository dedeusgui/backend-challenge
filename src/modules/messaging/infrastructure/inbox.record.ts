import { defineEntity, p } from '@mikro-orm/postgresql';

/** Persistence shape of an inbox row. (consumer_name, message_id) is the primary key. */
const InboxMessageRecordSchema = defineEntity({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.string().columnType('text').primary(),
    messageId: p.string().columnType('text').primary(),
    payloadHash: p.string().columnType('char(64)'),
    receivedAt: p.datetime().columnType('timestamptz'),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});

export class InboxMessageRecord extends InboxMessageRecordSchema.class {}
InboxMessageRecordSchema.setClass(InboxMessageRecord);
