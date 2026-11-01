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
} from '../../application/ports/financial-unit-of-work';

interface FinancialUnitOfWorkOptions {
  /** Longest wait for a row lock. Past it the attempt fails with SQLSTATE 55P03, which is transient. */
  lockTimeoutMs?: number;
  /** Longest run of one statement. Past it the statement is cancelled with SQLSTATE 57014. */
  statementTimeoutMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Runs financial work in one PostgreSQL transaction on a fresh EntityManager, so
 * each unit of work has its own identity map and connection. The timeouts are set
 * with `set_config(..., true)`, which lasts for this transaction only.
 */
export class MikroOrmFinancialUnitOfWork implements FinancialUnitOfWork {
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;

  constructor(
    private readonly orm: MikroORM,
    options: FinancialUnitOfWorkOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  }

  run<T>(work: (repositories: FinancialRepositories) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      await em.execute(
        "SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)",
        [`${this.lockTimeoutMs}ms`, `${this.statementTimeoutMs}ms`],
      );
      return work(repositoriesOn(em));
    });
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
