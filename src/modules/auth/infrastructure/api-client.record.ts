import { defineEntity, p } from '@mikro-orm/postgresql';

/** Persistence shape of an API client. The key itself is never stored, only its SHA-256 hash. */
export const ApiClientRecordSchema = defineEntity({
  name: 'ApiClientRecord',
  tableName: 'api_clients',
  properties: {
    id: p.string().columnType('uuid').primary(),
    name: p.string().columnType('text'),
    role: p.string().columnType('text'),
    providerId: p.string().columnType('text').nullable(),
    keyHash: p.string().columnType('char(64)'),
    createdAt: p.datetime().columnType('timestamptz'),
    revokedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});

export class ApiClientRecord extends ApiClientRecordSchema.class {}
ApiClientRecordSchema.setClass(ApiClientRecord);
