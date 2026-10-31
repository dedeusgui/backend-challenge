import type { MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  FinancialRepositories,
  FinancialUnitOfWork,
} from '../../application/ports/financial-unit-of-work.port';
import { MikroOrmWalletLedgerRepository } from '../../../modules/wallet/infrastructure/mikro-orm-wallet-ledger.repository';
import { MikroOrmWalletRepository } from '../../../modules/wallet/infrastructure/mikro-orm-wallet.repository';
import { MikroOrmWagerTransactionRepository } from '../../../modules/wagering/infrastructure/mikro-orm-wager-transaction.repository';

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
  };
}
