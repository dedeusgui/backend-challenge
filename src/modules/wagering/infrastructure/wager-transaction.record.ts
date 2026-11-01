import { defineEntity, p } from '@mikro-orm/postgresql';

/** Persistence shape of a wager transaction row. Check constraints in the migration guard its shape. */
const WagerTransactionRecordSchema = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.string().columnType('uuid').primary(),
    providerId: p.string().columnType('text'),
    externalTransactionId: p.string().columnType('text'),
    idempotencyKey: p.string().columnType('text'),
    payloadHash: p.string().columnType('char(64)'),
    walletId: p.string().columnType('uuid'),
    playerId: p.string().columnType('text'),
    roundId: p.string().columnType('text'),
    gameId: p.string().columnType('text'),
    kind: p.string().columnType('text'),
    amount: p.string().columnType('numeric(20,2)'),
    currency: p.string().columnType('char(3)'),
    referenceExternalTransactionId: p.string().columnType('text').nullable(),
    referenceTransactionId: p.string().columnType('uuid').nullable(),
    status: p.string().columnType('text'),
    failureCode: p.string().columnType('text').nullable(),
    resultingBalance: p.string().columnType('numeric(20,2)').nullable(),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
    referenceAttempts: p.integer(),
    referenceNextAttemptAt: p.datetime().columnType('timestamptz').nullable(),
    createdAt: p.datetime().columnType('timestamptz'),
  },
});

export class WagerTransactionRecord extends WagerTransactionRecordSchema.class {}
WagerTransactionRecordSchema.setClass(WagerTransactionRecord);
