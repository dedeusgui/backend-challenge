import { defineEntity, p } from '@mikro-orm/postgresql';

/** Persistence shape of a wallet row. Converted to and from the Wallet aggregate by the repository. */
export const WalletRecordSchema = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.string().columnType('uuid').primary(),
    playerId: p.string().columnType('text'),
    currency: p.string().columnType('char(3)'),
    balance: p.string().columnType('numeric(20,2)'),
    version: p.integer(),
    createdAt: p.datetime().columnType('timestamptz'),
    updatedAt: p.datetime().columnType('timestamptz'),
  },
});

export class WalletRecord extends WalletRecordSchema.class {}
WalletRecordSchema.setClass(WalletRecord);
