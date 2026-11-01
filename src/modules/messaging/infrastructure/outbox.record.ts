import { defineEntity, p } from '@mikro-orm/postgresql';

/** Persistence shape of an outbox row. The lease columns belong to the publisher, not to the domain. */
const OutboxMessageRecordSchema = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.string().columnType('uuid').primary(),
    aggregateId: p.string().columnType('text'),
    eventType: p.string().columnType('text'),
    payload: p.json(),
    occurredAt: p.datetime().columnType('timestamptz'),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().columnType('timestamptz'),
    publishedAt: p.datetime().columnType('timestamptz').nullable(),
    status: p.string().columnType('text'),
    leaseToken: p.string().columnType('uuid').nullable(),
    leaseExpiresAt: p.datetime().columnType('timestamptz').nullable(),
  },
});

export class OutboxMessageRecord extends OutboxMessageRecordSchema.class {}
OutboxMessageRecordSchema.setClass(OutboxMessageRecord);
