import type { DatabaseClock } from './database-clock.port';
import type { InboxRepository } from '../../../modules/messaging/application/inbox-repository.port';
import type { OutboxRepository } from '../../../modules/messaging/application/outbox-repository.port';
import type { WalletLedgerRepository } from '../../../modules/wallet/application/wallet-ledger-repository.port';
import type { WalletRepository } from '../../../modules/wallet/application/wallet-repository.port';
import type { WagerTransactionRepository } from '../../../modules/wagering/application/wager-transaction-repository.port';

export interface FinancialRepositories {
  wallets: WalletRepository;
  ledger: WalletLedgerRepository;
  wagers: WagerTransactionRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
  /** The database's clock, for every time that decides when held work is due. */
  databaseClock: DatabaseClock;
}

/**
 * Transaction boundary for financial work. Everything done through the
 * repositories inside `work` commits or rolls back together, including the
 * outbox rows and the inbox record. Nothing outside `work` observes a partial result.
 */
export interface FinancialUnitOfWork {
  run<T>(work: (repositories: FinancialRepositories) => Promise<T>): Promise<T>;
}
