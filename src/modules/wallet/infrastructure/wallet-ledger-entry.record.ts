import { defineEntity, p } from '@mikro-orm/postgresql';

/** Persistence shape of a ledger row. `seq` is assigned by the database and orders the ledger. */
export const WalletLedgerEntryRecordSchema = defineEntity({
  name: 'WalletLedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.string().columnType('uuid').primary(),
    seq: p.string().columnType('bigint').nullable(),
    walletId: p.string().columnType('uuid'),
    transactionId: p.string().columnType('uuid'),
    direction: p.string().columnType('text'),
    currency: p.string().columnType('char(3)'),
    amount: p.string().columnType('numeric(20,2)'),
    balanceBefore: p.string().columnType('numeric(20,2)'),
    balanceAfter: p.string().columnType('numeric(20,2)'),
    createdAt: p.datetime().columnType('timestamptz'),
  },
});

export class WalletLedgerEntryRecord extends WalletLedgerEntryRecordSchema.class {}
WalletLedgerEntryRecordSchema.setClass(WalletLedgerEntryRecord);
