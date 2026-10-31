import type { Options } from '@mikro-orm/postgresql';
import { WalletLedgerEntryRecord } from '../../../modules/wallet/infrastructure/wallet-ledger-entry.record';
import { WalletRecord } from '../../../modules/wallet/infrastructure/wallet.record';
import { WagerTransactionRecord } from '../../../modules/wagering/infrastructure/wager-transaction.record';
import { InboxMessageRecord } from '../../../modules/messaging/infrastructure/inbox.record';
import { OutboxMessageRecord } from '../../../modules/messaging/infrastructure/outbox.record';
import { ApiClientRecord } from '../../../modules/auth/infrastructure/api-client.record';

/**
 * MikroORM configuration shared by the HTTP process, workers and tests. Schema
 * changes happen only through the versioned migrations in ./migrations; there is
 * no automatic schema synchronization.
 */
export function ormOptions(clientUrl: string): Options {
  return {
    clientUrl,
    entities: [
      WalletRecord,
      WalletLedgerEntryRecord,
      WagerTransactionRecord,
      InboxMessageRecord,
      OutboxMessageRecord,
      ApiClientRecord,
    ],
    migrations: {
      path: `${import.meta.dir}/migrations`,
      pathTs: `${import.meta.dir}/migrations`,
      glob: '!(*.d).{ts,js}',
      transactional: true,
      // Schema snapshots are a MikroORM generator feature; this project writes migrations by hand.
      snapshot: false,
      snapshotOnMigrate: false,
    },
  };
}
