import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmDatabaseClock } from './mikro-orm-database-clock';
import { MikroOrmInboxRepository } from '../../../modules/messaging/infrastructure/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../../../modules/messaging/infrastructure/mikro-orm-outbox.repository';
import { MikroOrmWagerTransactionRepository } from '../../../modules/wagering/infrastructure/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletLedgerRepository } from '../../../modules/wallet/infrastructure/mikro-orm-wallet-ledger.repository';
import { MikroOrmWalletRepository } from '../../../modules/wallet/infrastructure/mikro-orm-wallet.repository';
import type {
  FinancialRepositories,
  FinancialUnitOfWork,
} from '../../application/ports/financial-unit-of-work.port';

/**
 * Runs financial work in one PostgreSQL transaction on a fresh EntityManager, so
 * each unit of work has its own identity map and connection.
 */
export class MikroOrmFinancialUnitOfWork implements FinancialUnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  run<T>(work: (repositories: FinancialRepositories) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional((em) => work(repositoriesOn(em)));
  }
}

function repositoriesOn(em: EntityManager): FinancialRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmWalletLedgerRepository(em),
    wagers: new MikroOrmWagerTransactionRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    databaseClock: new MikroOrmDatabaseClock(em),
  };
}
